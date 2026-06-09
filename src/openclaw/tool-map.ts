/**
 * OpenClaw tool name mapping.
 *
 * OpenClaw uses its own tool names (exec, read, write, etc.) that differ from
 * the Claude Code equivalents (Bash, Read, Write, etc.). The Claude model has
 * stronger priors for the Claude Code names, so remapping improves tool use.
 *
 * The reverse map is built per-request so response tool_use blocks can be
 * translated back to the names the client expects.
 */

import type { AnthropicToolDefinition } from '../protocol/anthropic-types.js';
import { logger } from '../util/logger.js';

// OpenClaw tool name -> Claude-native name. The model has strong priors for the
// Claude-native names AND their native parameter names/casing, and uses them even
// when sent a differently-named tool/schema (verified 2026-06-03: a tool named
// "write" with a "path" param still came back as Write(file_path=...)). So the
// mapping is necessary, but the RESPONSE side must translate both the name (via
// reverseToolMap) AND the parameter keys (via CLAUDE_PARAM_TO_OPENCLAW) back.
// "agent" was previously missing -> the model's "Agent" call hit no reverse entry
// -> "Tool Agent not found" -> OpenClaw's uncapped retry looped and burned quota.
const OPENCLAW_TO_CLAUDE: Record<string, string> = {
  exec: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  browser: 'Browser',
  canvas: 'Canvas',
  agent: 'Agent',
};

// Claude-native parameter key -> OpenClaw parameter key. The model emits its native
// param names (e.g. Write/Read/Edit use "file_path") regardless of the schema we
// send; OpenClaw's file tools expect "path". Applied to response tool_use input.
const CLAUDE_PARAM_TO_OPENCLAW: Record<string, string> = {
  file_path: 'path',
};

/**
 * Per-tool input SHAPE transforms (distinct from the param-KEY rename above).
 *
 * The model emits Claude-Code-native tool *shapes* regardless of the OpenClaw
 * schema we send — the same training-prior root cause as the name/param-key
 * issues. Two shapes leak through and fail OpenClaw's tool-layer validation:
 *   - Edit:        {file_path, old_string, new_string} -> OpenClaw 6.1 wants {path, edits:[{oldText,newText}]}
 *                  ("edits: must have required properties edits")
 *   - spawn/Agent: {prompt, ...}                        -> OpenClaw wants {task, ...}
 *                  ("task: must have required properties task")
 *
 * Each transform is matched by the RESOLVED OpenClaw tool name (the reverse-mapped
 * name the client actually uses), runs AFTER the generic param-key rename, and is
 * idempotent (a no-op on already-correct input). Table-driven so the next shape
 * (BUG 4, 5, ...) is one row, not another branch.
 *
 * Schema note (2026-06-08, OpenClaw 2026.6.1): the edit element schema is
 * `{oldText, newText}` (camelCase) with additionalProperties:false — confirmed in the
 * installed bundle (sessions-*.js replaceEditSchema) AND by a live `edit` probe that
 * rejected snake_case. The model emits Claude-native snake keys, so the transform
 * RENAMES old_string->oldText / new_string->newText and DROPS replace_all (not in the
 * 6.1 schema). Earlier 5.x assumed snake element keys; 6.1 moved that goalpost.
 */
type ToolInputTransform = (input: Record<string, unknown>) => Record<string, unknown>;

/** Edit: wrap a single Claude-native {old_string,new_string,replace_all?} into OpenClaw's edits[]. */
function reshapeEditInput(input: Record<string, unknown>): Record<string, unknown> {
  if ('edits' in input) return input; // already OpenClaw shape — idempotent
  if (!('old_string' in input) && !('new_string' in input)) return input; // not the single-edit shape
  const { old_string, new_string, replace_all, ...rest } = input;
  // OpenClaw 2026.6.1 edit element schema = {oldText, newText}, additionalProperties:false.
  // The model emits Claude-native snake keys (old_string/new_string) — rename to camelCase.
  // replace_all is intentionally DROPPED: 6.1's replaceEditSchema forbids extra props and
  // requires oldText to be unique, so there is no replace_all concept to forward.
  void replace_all;
  const edit: Record<string, unknown> = {};
  if (old_string !== undefined) edit.oldText = old_string;
  if (new_string !== undefined) edit.newText = new_string;
  return { ...rest, edits: [edit] }; // `path` already renamed from file_path by the time we get here
}

/** spawn/Agent: model emits `prompt`; OpenClaw wants `task`. Rename only if `task` absent. */
function reshapeSpawnInput(input: Record<string, unknown>): Record<string, unknown> {
  if ('task' in input || !('prompt' in input)) return input; // idempotent / nothing to do
  const { prompt, ...rest } = input;
  return { ...rest, task: prompt };
}

// Matched against the RESOLVED OpenClaw tool name. The spawn pattern mirrors the
// NATIVE_ALIASES spawn regex below so it covers whatever the request names the agent tool.
const TOOL_INPUT_TRANSFORMS: Array<{ match: RegExp; transform: ToolInputTransform }> = [
  { match: /^edit$/i, transform: reshapeEditInput },
  { match: /^(sessions_spawn|spawn|subagents?|run_agent|delegate)$/i, transform: reshapeSpawnInput },
];

/**
 * Translate a response tool_use input back to the shape the OpenClaw client expects.
 *   1. Rename Claude-native param KEYS (file_path -> path) — applies to every tool.
 *   2. If `openclawToolName` matches a per-tool transform, reshape the input STRUCTURE.
 * Safe on any input: unknown tools / already-correct shapes pass through untouched.
 * `openclawToolName` is optional so callers without a resolved name keep rename-only behavior.
 */
export function remapToolInput(input: unknown, openclawToolName?: string): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const renamed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    renamed[CLAUDE_PARAM_TO_OPENCLAW[k] ?? k] = v;
  }
  if (openclawToolName) {
    for (const { match, transform } of TOOL_INPUT_TRANSFORMS) {
      if (match.test(openclawToolName)) return transform(renamed);
    }
  }
  return renamed;
}

/**
 * Map an OpenClaw tool name to its Claude Code equivalent.
 * Returns the original name if no mapping exists.
 */
export function mapToolName(name: string): string {
  return OPENCLAW_TO_CLAUDE[name] || name;
}

/**
 * Apply tool name mapping to an array of Anthropic tool definitions.
 * Returns mapped tools and a reverse map for translating response tool names
 * back to the original client names.
 */
export function mapToolDefinitions(
  tools: AnthropicToolDefinition[],
): { mappedTools: AnthropicToolDefinition[]; reverseToolMap: Record<string, string> } {
  const reverseToolMap: Record<string, string> = {};

  const seenNames = new Map<string, string>();

  const mappedTools = tools.map(tool => {
    const mapped = mapToolName(tool.name);
    const previous = seenNames.get(mapped);
    if (previous) {
      logger.warn(`Tool name collision: "${tool.name}" and "${previous}" both map to "${mapped}". Skipping "${tool.name}" to avoid overwrite.`);
      return { ...tool };
    }
    seenNames.set(mapped, tool.name);
    if (mapped !== tool.name) {
      reverseToolMap[mapped] = tool.name;
    }
    return { ...tool, name: mapped };
  });

  // Native-name hallucination guard (2026-06-03). The model has strong priors to call
  // its Claude Code native tools ("Skill", "Agent"/"Task", "TodoWrite", "WebFetch"...)
  // REGARDLESS of what OpenClaw names them ("skills", "sessions_spawn", "update_plan",
  // "web_fetch"...). Each wrong guess costs a wasted round ("Tool X not found" -> retry),
  // so Pepper would cycle through several names before landing the right one. Map each
  // well-known native name onto whichever matching tool the request ACTUALLY provides —
  // schema-discovering, and only when a target is present, so real calls are untouched.
  const NATIVE_ALIASES: Array<[string, RegExp]> = [
    ['Agent',     /^(sessions_spawn|spawn|subagents?|run_agent|delegate)$/i],
    ['Task',      /^(sessions_spawn|spawn|subagents?|run_agent|delegate)$/i],
    ['Skill',     /^(skills?|run_skill|invoke_skill|use_skill)$/i],
    ['TodoWrite', /^(update_plan|todo_write|todos?|plan)$/i],
    ['WebFetch',  /^(web_fetch|fetch_url|fetch)$/i],
    ['WebSearch', /^(web_search|x_search|search_web)$/i],
    ['Bash',      /^(exec|bash|shell|run_command)$/i],
    ['Glob',      /^(glob|find_files|list_files)$/i],
    ['Grep',      /^(grep|ripgrep|search_files|search_code)$/i],
  ];
  for (const [native, re] of NATIVE_ALIASES) {
    if (native in reverseToolMap || seenNames.has(native)) continue; // already mapped / a real tool
    const target = tools.find(t => re.test(t.name));
    if (target) reverseToolMap[native] = target.name;
  }

  return { mappedTools, reverseToolMap };
}
