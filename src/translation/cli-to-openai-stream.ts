import type { CliEvent } from '../protocol/cli-types.js';
import type { OpenAIChatCompletionChunk, OpenAICompletionUsage } from '../protocol/openai-types.js';
import { logger } from '../util/logger.js';
import { stripMcpToolPrefix } from '../tools/tool-translator.js';
import { parseAnyToolCallText } from './function-call-text-parser.js';
import { remapToolInput } from '../openclaw/tool-map.js';

/** Reverse-map Claude-native param keys (e.g. file_path) to OpenClaw's (path) in an args JSON string. */
function remapArgsJson(argsJson: string): string {
  if (!argsJson) return argsJson;
  try {
    return JSON.stringify(remapToolInput(JSON.parse(argsJson)));
  } catch {
    return argsJson;
  }
}
import { makeEmptyUsage, updateUsageFromEvent } from './cli-to-openai.js';

function makeChunk(
  id: string,
  model: string,
  delta: OpenAIChatCompletionChunk['choices'][0]['delta'],
  finishReason: OpenAIChatCompletionChunk['choices'][0]['finish_reason'],
): OpenAIChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    system_fingerprint: null,
  };
}

function makeUsageChunk(
  id: string,
  model: string,
  usage: OpenAICompletionUsage,
): OpenAIChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    system_fingerprint: null,
    usage,
  };
}

/**
 * Transform CLI events into OpenAI SSE text chunks.
 * @param reverseToolMap - Optional map to translate CLI tool names back to client names
 * @param includeUsage   - When true, emit a final chunk with empty `choices` and a populated
 *                         `usage` object before `[DONE]`, per the OpenAI streaming contract for
 *                         `stream_options.include_usage: true`. The chunk is suppressed on
 *                         rate-limit errors, since those terminate the stream with an error event.
 */
export async function* cliToOpenAISSE(
  events: AsyncGenerator<CliEvent>,
  reverseToolMap?: Record<string, string>,
  validToolNames?: string[],
  includeUsage = false,
): AsyncGenerator<string> {
  let messageId = '';
  let model = '';
  let toolCallIndex = -1;
  let sentRole = false;
  let sawToolUseStop = false;
  // Buffer the current tool_use block's streamed input JSON so we can rename
  // Claude-native param keys (file_path -> path) before emitting. Renaming can't be
  // done on partial JSON fragments, so we hold the args and flush them at block stop.
  let pendingToolArgs: string | null = null;
  // Buffer assistant text so we can detect <function_calls> XML that the CLI
  // sometimes emits as text instead of native tool_use, and convert it.
  let textBuffer = '';
  // TEMP DIAGNOSTIC: track stream shape for empty-payload investigation
  const _diag = { textChunks: 0, toolChunks: 0, thinkingDeltas: 0, otherDeltas: 0, blocks: [] as string[], finishReason: '' as string, ranToCompletion: false };
  const usage: OpenAICompletionUsage = makeEmptyUsage();

  for await (const event of events) {
    updateUsageFromEvent(usage, event);

    if (event.type !== 'stream_event') {
      if (event.type === 'system') {
        model = event.model;
      }
      if (event.type === 'result' && event.subtype === 'error') {
        logger.error('CLI error in OpenAI stream', { result: event.result });
      }
      if (event.type === 'rate_limit_event' && event.rate_limit_info.status !== 'allowed' && event.rate_limit_info.status !== 'allowed_warning') {
        logger.warn('Rate limited by CLI', { info: event.rate_limit_info });
        const errorPayload = {
          error: {
            message: event.rate_limit_info.message || 'Rate limit exceeded',
            type: 'rate_limit_error',
            code: '429',
            reset_at: event.rate_limit_info.reset,
          },
        };
        yield `data: ${JSON.stringify(errorPayload)}\n\n`;
        yield 'data: [DONE]\n\n';
        return;
      }
      continue;
    }

    const inner = event.event;

    switch (inner.type) {
      case 'message_start': {
        messageId = inner.message.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
        model = inner.message.model || model;
        // Send initial role chunk
        if (!sentRole) {
          const chunk = makeChunk(messageId, model, { role: 'assistant' }, null);
          yield `data: ${JSON.stringify(chunk)}\n\n`;
          sentRole = true;
        }
        break;
      }

      case 'content_block_start': {
        const block = inner.content_block;
        _diag.blocks.push(`${block.type}@${inner.index}`);
        if (block.type === 'tool_use') {
          toolCallIndex++;
          pendingToolArgs = ''; // start buffering this block's input JSON
          const chunk = makeChunk(messageId, model, {
            tool_calls: [{
              index: toolCallIndex,
              id: block.id,
              type: 'function',
              function: { name: stripMcpToolPrefix(block.name, reverseToolMap), arguments: '' },
            }],
          }, null);
          yield `data: ${JSON.stringify(chunk)}\n\n`;
        }
        // Skip thinking blocks for OpenAI format
        break;
      }

      case 'content_block_delta': {
        if (inner.delta.type === 'text_delta') {
          _diag.textChunks++;
          // Buffer instead of emitting live, so a <function_calls> block can be
          // recovered into tool_calls at message_delta. Flushed there if it's plain text.
          textBuffer += inner.delta.text;
        } else if (inner.delta.type === 'thinking_delta' || inner.delta.type === 'signature_delta') {
          _diag.thinkingDeltas++;
        } else if (inner.delta.type === 'input_json_delta') {
          _diag.toolChunks++;
          // Buffer instead of emitting live — flushed (remapped) at content_block_stop.
          if (pendingToolArgs !== null) {
            pendingToolArgs += inner.delta.partial_json;
          }
        }
        // Skip thinking_delta and signature_delta for OpenAI
        break;
      }

      case 'message_delta': {
        // Safety net: flush any tool args not yet closed by a content_block_stop.
        if (pendingToolArgs !== null) {
          yield `data: ${JSON.stringify(makeChunk(messageId, model, {
            tool_calls: [{ index: toolCallIndex, function: { arguments: remapArgsJson(pendingToolArgs) } }],
          }, null))}\n\n`;
          pendingToolArgs = null;
        }
        let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop';
        if (inner.delta.stop_reason === 'tool_use') {
          finishReason = 'tool_calls';
          sawToolUseStop = true;
        } else if (inner.delta.stop_reason === 'max_tokens') {
          finishReason = 'length';
        }
        // Recover tool calls the CLI emitted as <function_calls> text (no native tool_use seen).
        if (toolCallIndex === -1 && (textBuffer.includes('<invoke') || (textBuffer.includes('"name"') && textBuffer.includes('"input"')))) {
          const parsed = parseAnyToolCallText(textBuffer, reverseToolMap, validToolNames);
          if (parsed) {
            if (parsed.preText) {
              yield `data: ${JSON.stringify(makeChunk(messageId, model, { content: parsed.preText }, null))}\n\n`;
            }
            let ti = 0;
            for (const tc of parsed.toolCalls) {
              _diag.toolChunks++;
              yield `data: ${JSON.stringify(makeChunk(messageId, model, {
                tool_calls: [{ index: ti, id: tc.id, type: 'function', function: { name: tc.name, arguments: remapArgsJson(tc.argsJson) } }],
              }, null))}\n\n`;
              ti++;
            }
            _diag.finishReason = 'tool_calls(recovered)';
            yield `data: ${JSON.stringify(makeChunk(messageId, model, {}, 'tool_calls'))}\n\n`;
            logger.info('STREAM_DIAG (recovered function_calls text)', _diag);
            yield 'data: [DONE]\n\n';
            return;
          }
        }

        // Flush buffered plain text (we held it back in case it was a function_calls block).
        if (textBuffer.length > 0) {
          yield `data: ${JSON.stringify(makeChunk(messageId, model, { content: textBuffer }, null))}\n\n`;
        }
        _diag.finishReason = finishReason;
        // Defensive patch: no content at all on a normal stop → emit empty content for strict clients.
        if (textBuffer.length === 0 && _diag.toolChunks === 0 && finishReason === 'stop') {
          logger.debug('No content chunks emitted; injecting empty content chunk to satisfy strict clients');
          const fillerChunk = makeChunk(messageId, model, { content: '' }, null);
          yield `data: ${JSON.stringify(fillerChunk)}\n\n`;
        }
        const chunk = makeChunk(messageId, model, {}, finishReason);
        yield `data: ${JSON.stringify(chunk)}\n\n`;
        break;
      }

      case 'message_stop': {
        // After message_stop for a tool_use turn, emit [DONE] and stop.
        // The CLI would continue into a second turn with the MCP bridge's
        // placeholder result — that garbage must never reach the client.
        if (sawToolUseStop) {
          logger.debug('Stopping stream after tool_use turn (intercepting MCP placeholder turn)');
          logger.info('STREAM_DIAG (tool_use exit)', _diag);
          if (includeUsage) {
            yield `data: ${JSON.stringify(makeUsageChunk(messageId, model, usage))}\n\n`;
          }
          yield 'data: [DONE]\n\n';
          return;
        }
        break;
      }

      case 'content_block_stop':
        // Flush the buffered tool args with param keys remapped (file_path -> path).
        if (pendingToolArgs !== null) {
          yield `data: ${JSON.stringify(makeChunk(messageId, model, {
            tool_calls: [{ index: toolCallIndex, function: { arguments: remapArgsJson(pendingToolArgs) } }],
          }, null))}\n\n`;
          pendingToolArgs = null;
        }
        break;

      default:
        break;
    }
  }

  _diag.ranToCompletion = true;
  logger.info('STREAM_DIAG', _diag);
  if (includeUsage) {
    yield `data: ${JSON.stringify(makeUsageChunk(messageId, model, usage))}\n\n`;
  }
  yield 'data: [DONE]\n\n';
}
