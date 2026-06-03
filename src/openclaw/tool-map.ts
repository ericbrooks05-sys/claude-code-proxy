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
 * Translate a response tool_use input object's parameter keys from Claude-native
 * names back to the names the OpenClaw client expects. Safe to call on any input:
 * only known aliased keys are renamed; everything else passes through untouched.
 */
export function remapToolInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[CLAUDE_PARAM_TO_OPENCLAW[k] ?? k] = v;
  }
  return out;
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

  // Subagent hallucination guard (2026-06-03). The model has a strong prior to call
  // its native subagent tools "Agent"/"Task" REGARDLESS of what the client names its
  // spawner (OpenClaw's main agent calls it "sessions_spawn"). When it does, OpenClaw
  // rejects "Tool Agent not found" and retries — a wasteful loop. So map those
  // hallucinated names onto whichever subagent-like tool the request actually provides.
  // Schema-discovering (works for any spawner name); only adds an alias if that name
  // isn't already a real/mapped tool, so correct sessions_spawn calls are untouched.
  const SUBAGENT_RE = /^(sessions_spawn|spawn|subagent|agent|task|run_agent|delegate)$/i;
  const spawner = tools.find(t => SUBAGENT_RE.test(t.name));
  if (spawner) {
    for (const alias of ['Agent', 'Task']) {
      if (!(alias in reverseToolMap) && !seenNames.has(alias)) {
        reverseToolMap[alias] = spawner.name;
      }
    }
  }

  return { mappedTools, reverseToolMap };
}
