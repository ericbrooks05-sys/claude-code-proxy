import { badRequest } from '../util/errors.js';
import { logger } from '../util/logger.js';

const MODEL_ALIASES: Record<string, string> = {
  // Opus aliases
  'claude-opus-4-6': 'opus',
  'claude-opus-4-7': 'opus',
  'claude-opus-4-8': 'opus',
  'claude-opus-4': 'opus',
  'opus': 'opus',
  'opus-4': 'opus',
  'opus-4-6': 'opus',
  'opus-4-7': 'opus',
  'opus-4-8': 'opus',
  // Sonnet aliases
  'claude-sonnet-4-6': 'sonnet',
  'claude-sonnet-4': 'sonnet',
  'sonnet': 'sonnet',
  'sonnet-4': 'sonnet',
  'sonnet-4-6': 'sonnet',
  // Haiku aliases
  'claude-haiku-4-5': 'haiku',
  'claude-haiku-4': 'haiku',
  'haiku': 'haiku',
  'haiku-4': 'haiku',
  'haiku-4-5': 'haiku',
};

/**
 * Prefixes that are stripped before model alias lookup.
 * Allows clients like OpenClaw to send e.g. "claude-code-cli/opus".
 */
const STRIP_PREFIXES = ['claude-code-cli/', 'openai/'];

// Map CLI model names back to full Anthropic model IDs for responses
const CLI_TO_API_MODEL: Record<string, string> = {
  'opus': 'claude-opus-4-8',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5',
};

// Effort level constraints per model
const EFFORT_BY_MODEL: Record<string, string[]> = {
  opus: ['low', 'medium', 'high', 'max'],
  sonnet: ['low', 'medium', 'high'],
  haiku: [], // No effort support
};

/**
 * Strip known prefixes from model names.
 * E.g. "claude-code-cli/opus" → "opus", "openai/gpt-4.1" → "gpt-4.1"
 */
function stripModelPrefix(model: string): string {
  for (const prefix of STRIP_PREFIXES) {
    if (model.startsWith(prefix)) {
      return model.slice(prefix.length);
    }
  }
  return model;
}

export function toCliModel(model: string, defaultCliModel?: string): string {
  const stripped = stripModelPrefix(model);
  const normalized = MODEL_ALIASES[stripped];
  if (normalized) return normalized;

  // Unknown model — fall back to default if provided
  if (defaultCliModel) {
    const fallback = MODEL_ALIASES[defaultCliModel] || defaultCliModel;
    logger.warn(`Unknown model "${model}", falling back to "${fallback}"`);
    return fallback;
  }

  throw badRequest(`Unknown model: ${model}. Supported models: ${Object.keys(MODEL_ALIASES).join(', ')}`);
}

export function toApiModel(cliModel: string): string {
  return CLI_TO_API_MODEL[cliModel] || cliModel;
}

export function validateEffort(model: string, effort: string | undefined, defaultEffort: string): string | null {
  const stripped = stripModelPrefix(model);
  const cliModel = MODEL_ALIASES[stripped] || stripped;
  const allowed = EFFORT_BY_MODEL[cliModel];

  if (!allowed || allowed.length === 0) {
    return null; // Model doesn't support effort
  }

  const effectiveEffort = effort || defaultEffort;

  if (!allowed.includes(effectiveEffort)) {
    if (!effort) {
      // Default effort not valid for this model; use model's highest supported
      return allowed[allowed.length - 1];
    }
    throw badRequest(
      `Effort level "${effort}" is not supported for model "${model}". Supported: ${allowed.join(', ')}`
    );
  }

  return effectiveEffort;
}

export function getAllModels(): Array<{ id: string; owned_by: string }> {
  return [
    { id: 'claude-opus-4-8', owned_by: 'anthropic' },
    { id: 'claude-sonnet-4-6', owned_by: 'anthropic' },
    { id: 'claude-haiku-4-5', owned_by: 'anthropic' },
  ];
}
