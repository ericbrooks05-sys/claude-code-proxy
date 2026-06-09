import type { CliEvent, RateLimitInfo, Usage } from '../protocol/cli-types.js';
import type { OpenAIChatCompletionResponse, OpenAIToolCall, OpenAICompletionUsage } from '../protocol/openai-types.js';
import { logger } from '../util/logger.js';
import { serverError, rateLimited } from '../util/errors.js';
import { stripMcpToolPrefix } from '../tools/tool-translator.js';
import { parseAnyToolCallText } from './function-call-text-parser.js';
import { remapToolInput } from '../openclaw/tool-map.js';

/**
 * Reverse-map a response tool_use args JSON string to the OpenClaw shape:
 * param-key rename (file_path -> path) plus, when `toolName` (the resolved OpenClaw
 * tool name) is given, the per-tool shape transform (Edit -> edits[], spawn -> task).
 */
function remapArgsJson(argsJson: string, toolName?: string): string {
  if (!argsJson) return argsJson;
  try {
    return JSON.stringify(remapToolInput(JSON.parse(argsJson), toolName));
  } catch {
    return argsJson; // partial/invalid JSON — leave untouched
  }
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  partialJson: string;
}

/**
 * Build a fresh usage record initialized to zero, including the optional
 * Anthropic-style cache fields and the OpenAI `prompt_tokens_details` mirror.
 */
export function makeEmptyUsage(): OpenAICompletionUsage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
  };
}

function applyCacheFields(usage: OpenAICompletionUsage, cliUsage: Usage): void {
  if (cliUsage.cache_read_input_tokens !== undefined) {
    usage.cache_read_input_tokens = cliUsage.cache_read_input_tokens;
    usage.prompt_tokens_details = { cached_tokens: cliUsage.cache_read_input_tokens };
  }
  if (cliUsage.cache_creation_input_tokens !== undefined) {
    usage.cache_creation_input_tokens = cliUsage.cache_creation_input_tokens;
  }
}

/**
 * Update the running usage totals from a single CLI event. Mutates `usage` in place.
 * Shared between the streaming and non-streaming OpenAI translators so the two paths
 * report identical token counts (including cache fields) for the same event sequence.
 */
export function updateUsageFromEvent(usage: OpenAICompletionUsage, event: CliEvent): void {
  if (event.type === 'stream_event') {
    const inner = event.event;
    if (inner.type === 'message_start') {
      usage.prompt_tokens = inner.message.usage.input_tokens;
      applyCacheFields(usage, inner.message.usage);
    } else if (inner.type === 'message_delta') {
      usage.completion_tokens = inner.usage.output_tokens;
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
    return;
  }
  if (event.type === 'result' && event.subtype === 'success' && event.usage) {
    usage.prompt_tokens = event.usage.input_tokens;
    usage.completion_tokens = event.usage.output_tokens;
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    applyCacheFields(usage, event.usage);
  }
}

/**
 * Collect all CLI events and build a non-streaming OpenAI Chat Completion response.
 * @param reverseToolMap - Optional map to translate CLI tool names back to client names
 */
export interface OpenAICollectResult {
  response: OpenAIChatCompletionResponse;
  rateLimitInfo?: RateLimitInfo;
}

export async function collectOpenAIResponse(
  events: AsyncGenerator<CliEvent>,
  reverseToolMap?: Record<string, string>,
  validToolNames?: string[],
): Promise<OpenAICollectResult> {
  let messageId = '';
  let model = '';
  let textContent = '';
  let finishReason: 'stop' | 'tool_calls' | 'length' | null = null;
  const toolCalls: AccumulatedToolCall[] = [];
  let currentToolCallIndex = -1;
  const usage: OpenAICompletionUsage = makeEmptyUsage();
  let sawToolUseStop = false;
  let rateLimitInfo: RateLimitInfo | undefined;

  eventLoop: for await (const event of events) {
    updateUsageFromEvent(usage, event);

    switch (event.type) {
      case 'stream_event': {
        const inner = event.event;

        if (inner.type === 'message_start') {
          messageId = inner.message.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
          model = inner.message.model || model;
        }

        if (inner.type === 'content_block_start') {
          if (inner.content_block.type === 'tool_use') {
            currentToolCallIndex++;
            toolCalls.push({
              id: inner.content_block.id,
              name: stripMcpToolPrefix(inner.content_block.name, reverseToolMap),
              partialJson: '',
            });
          }
        }

        if (inner.type === 'content_block_delta') {
          if (inner.delta.type === 'text_delta') {
            textContent += inner.delta.text;
          } else if (inner.delta.type === 'input_json_delta' && currentToolCallIndex >= 0) {
            toolCalls[currentToolCallIndex].partialJson += inner.delta.partial_json;
          }
        }

        if (inner.type === 'message_delta') {
          if (inner.delta.stop_reason === 'tool_use') {
            finishReason = 'tool_calls';
            sawToolUseStop = true;
          } else if (inner.delta.stop_reason === 'max_tokens') {
            finishReason = 'length';
          } else {
            finishReason = 'stop';
          }
        }

        // After message_stop for a tool_use turn, stop consuming events.
        // The CLI would continue into a second turn with the MCP bridge's
        // placeholder result — that garbage must never reach the client.
        if (inner.type === 'message_stop' && sawToolUseStop) {
          logger.debug('Stopping event collection after tool_use turn (intercepting MCP placeholder turn)');
          break eventLoop;
        }

        break;
      }

      case 'result': {
        if (event.subtype === 'error') {
          throw serverError(event.result || 'CLI returned an error');
        }
        break;
      }

      case 'rate_limit_event': {
        if (event.rate_limit_info.status !== 'allowed' && event.rate_limit_info.status !== 'allowed_warning') {
          throw rateLimited(
            event.rate_limit_info.message || 'Rate limit exceeded',
            event.rate_limit_info.reset,
          );
        }
        rateLimitInfo = {
          limit: event.rate_limit_info.limit,
          remaining: event.rate_limit_info.remaining,
          reset: event.rate_limit_info.reset,
        };
        break;
      }

      case 'system':
        model = event.model;
        break;

      default:
        break;
    }
  }

  // Fallback: the CLI sometimes emits tool calls as <function_calls> XML text
  // instead of native tool_use blocks. Recover them so the client gets tool_calls.
  if (toolCalls.length === 0 && (textContent.includes('<invoke') || (textContent.includes('"name"') && textContent.includes('"input"')))) {
    const parsed = parseAnyToolCallText(textContent, reverseToolMap, validToolNames);
    if (parsed) {
      for (const tc of parsed.toolCalls) {
        toolCalls.push({ id: tc.id, name: tc.name, partialJson: tc.argsJson });
      }
      textContent = parsed.preText;
      finishReason = 'tool_calls';
      logger.info('Recovered tool calls from <function_calls> text (non-streaming)', { count: parsed.toolCalls.length });
    }
  }

  // Build OpenAI tool calls from accumulated data
  const openaiToolCalls: OpenAIToolCall[] | undefined =
    toolCalls.length > 0
      ? toolCalls.map((tc, i) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: remapArgsJson(tc.partialJson, tc.name),
          },
        }))
      : undefined;

  return {
    response: {
      id: messageId || `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'unknown',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          tool_calls: openaiToolCalls,
        },
        finish_reason: finishReason || 'stop',
      }],
      usage,
      system_fingerprint: null,
    },
    rateLimitInfo,
  };
}
