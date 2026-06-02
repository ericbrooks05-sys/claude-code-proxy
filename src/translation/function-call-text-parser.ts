import { stripMcpToolPrefix } from '../tools/tool-translator.js';

/**
 * Fallback parser for tool calls that the Claude CLI sometimes emits as legacy
 * `<function_calls>` XML *text* inside the assistant's text content instead of as
 * native `tool_use` blocks. When that happens the MCP bridge path produces no
 * tool_use, so without this the call is silently returned as plain text and the
 * client (OpenClaw) never executes it.
 */

export interface ParsedTextToolCall {
  id: string;
  name: string;
  argsJson: string;
}

export interface ParsedFunctionCalls {
  preText: string;
  toolCalls: ParsedTextToolCall[];
}

/**
 * Recover the bare client tool name from whatever prefix the CLI text form used.
 * Handles `mcp__client_tools__X` (via stripMcpToolPrefix) and hallucinated
 * namespaces like `computer__X` by falling back to the segment after the last `__`.
 */
function normalizeToolName(raw: string, reverseToolMap?: Record<string, string>): string {
  const stripped = stripMcpToolPrefix(raw, reverseToolMap);
  if (stripped === raw && raw.includes('__')) {
    const tail = raw.split('__').pop() as string;
    return stripMcpToolPrefix(tail, reverseToolMap);
  }
  return stripped;
}

/**
 * In text mode the model may hallucinate the tool name (e.g. `execute_command`
 * instead of `exec`). Correct it against the actual requested tools — but ONLY on
 * high-confidence matches; otherwise leave it as-is (fail-safe: an unknown name is
 * rejected by the client exactly as before, never mis-routed).
 */
function correctToolName(name: string, validToolNames?: string[]): string {
  if (!validToolNames || validToolNames.length === 0) return name;
  if (validToolNames.includes(name)) return name;                          // exact
  const ci = validToolNames.find((v) => v.toLowerCase() === name.toLowerCase());
  if (ci) return ci;                                                        // case-insensitive
  if (validToolNames.length === 1) return validToolNames[0];               // only one possible tool
  const lc = name.toLowerCase();
  const sub = validToolNames.find((v) => lc.includes(v.toLowerCase()) || v.toLowerCase().includes(lc));
  if (sub) return sub;                                                      // synonym/substring (e.g. execute_command→exec)
  return name;                                                             // fail-safe: leave as-is
}

/**
 * Parse `<invoke name="...">` / `<parameter name="...">` blocks out of text.
 * Returns null if no complete invoke block is present.
 */
export function parseFunctionCallText(
  text: string,
  reverseToolMap?: Record<string, string>,
  validToolNames?: string[],
): ParsedFunctionCalls | null {
  if (!text || text.indexOf('<invoke') === -1) return null;

  const invokeRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
  const toolCalls: ParsedTextToolCall[] = [];
  let firstIndex = -1;
  let m: RegExpExecArray | null;

  while ((m = invokeRe.exec(text)) !== null) {
    if (firstIndex === -1) {
      const fc = text.lastIndexOf('<function_calls>', m.index);
      firstIndex = fc !== -1 ? fc : m.index;
    }
    const rawName = m[1];
    const body = m[2];
    const args: Record<string, string> = {};
    const paramRe = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(body)) !== null) {
      args[p[1]] = p[2].trim();
    }
    toolCalls.push({
      id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name: correctToolName(normalizeToolName(rawName, reverseToolMap), validToolNames),
      argsJson: JSON.stringify(args),
    });
  }

  if (toolCalls.length === 0) return null;
  const preText = (firstIndex > 0 ? text.slice(0, firstIndex) : '').trim();
  return { preText, toolCalls };
}

/**
 * Parse JSON-style tool calls the CLI sometimes emits as text, e.g.
 *   {"name": "exec", "input": {"command": "date"}}
 * Uses brace-matching (regex can't handle nested objects). Returns null if none.
 */
export function parseJsonToolCallText(
  text: string,
  reverseToolMap?: Record<string, string>,
  validToolNames?: string[],
): ParsedFunctionCalls | null {
  if (!text || text.indexOf('"name"') === -1 || text.indexOf('"input"') === -1) return null;

  const toolCalls: ParsedTextToolCall[] = [];
  let firstIndex = -1;
  const startRe = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"input"\s*:/g;
  let m: RegExpExecArray | null;

  while ((m = startRe.exec(text)) !== null) {
    const objStart = m.index;
    let depth = 0;
    let end = -1;
    let inStr = false;
    let esc = false;
    for (let i = objStart; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) continue;
    try {
      const obj = JSON.parse(text.slice(objStart, end + 1));
      if (obj && typeof obj.name === 'string' && obj.input !== undefined) {
        if (firstIndex === -1) firstIndex = objStart;
        toolCalls.push({
          id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          name: correctToolName(normalizeToolName(obj.name, reverseToolMap), validToolNames),
          argsJson: JSON.stringify(obj.input),
        });
      }
    } catch {
      // not valid JSON; skip
    }
  }

  if (toolCalls.length === 0) return null;
  const preText = (firstIndex > 0 ? text.slice(0, firstIndex) : '').trim();
  return { preText, toolCalls };
}

/**
 * Try every known text tool-call format the CLI may emit. XML first, then JSON.
 */
export function parseAnyToolCallText(
  text: string,
  reverseToolMap?: Record<string, string>,
  validToolNames?: string[],
): ParsedFunctionCalls | null {
  return (
    parseFunctionCallText(text, reverseToolMap, validToolNames) ??
    parseJsonToolCallText(text, reverseToolMap, validToolNames)
  );
}
