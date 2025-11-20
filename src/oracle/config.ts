import { countTokens as countTokensGpt5 } from 'gpt-tokenizer/model/gpt-5';
import { countTokens as countTokensGpt5Pro } from 'gpt-tokenizer/model/gpt-5-pro';
import type { ModelConfig, ModelName, ProModelName, TokenizerFn } from './types.js';
import { countTokens as countTokensAnthropicRaw } from '@anthropic-ai/tokenizer';
import { stringifyTokenizerInput } from './tokenStringifier.js';

export const DEFAULT_MODEL: ModelName = 'gpt-5.1-pro';
export const PRO_MODELS = new Set<ProModelName>(['gpt-5.1-pro', 'gpt-5-pro', 'claude-4.1-opus']);

const countTokensAnthropic: TokenizerFn = (input: unknown): number =>
  countTokensAnthropicRaw(stringifyTokenizerInput(input));

export const MODEL_CONFIGS: Record<ModelName, ModelConfig> = {
  'gpt-5.1-pro': {
    model: 'gpt-5.1-pro',
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 15 / 1_000_000,
      outputPerToken: 120 / 1_000_000,
    },
    reasoning: null,
  },
  'gpt-5-pro': {
    model: 'gpt-5-pro',
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 15 / 1_000_000,
      outputPerToken: 120 / 1_000_000,
    },
    reasoning: null,
  },
  'gpt-5.1': {
    model: 'gpt-5.1',
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 1.25 / 1_000_000,
      outputPerToken: 10 / 1_000_000,
    },
    reasoning: { effort: 'high' },
  },
  'gpt-5.1-codex': {
    model: 'gpt-5.1-codex',
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 1.25 / 1_000_000,
      outputPerToken: 10 / 1_000_000,
    },
    reasoning: { effort: 'high' },
  },
  'gemini-3-pro': {
    model: 'gemini-3-pro',
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 200000,
    pricing: {
      inputPerToken: 2 / 1_000_000,
      outputPerToken: 12 / 1_000_000,
    },
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
  },
  'claude-4.5-sonnet': {
    model: 'claude-4.5-sonnet',
    apiModel: 'claude-sonnet-4-5',
    tokenizer: countTokensAnthropic,
    inputLimit: 200000,
    pricing: {
      inputPerToken: 3 / 1_000_000,
      outputPerToken: 15 / 1_000_000,
    },
    reasoning: null,
    supportsBackground: false,
    supportsSearch: false,
  },
  'claude-4.1-opus': {
    model: 'claude-4.1-opus',
    apiModel: 'claude-opus-4-1',
    tokenizer: countTokensAnthropic,
    inputLimit: 200000,
    pricing: {
      inputPerToken: 15 / 1_000_000,
      outputPerToken: 75 / 1_000_000,
    },
    reasoning: { effort: 'high' },
    supportsBackground: false,
    supportsSearch: false,
  },
};

export const DEFAULT_SYSTEM_PROMPT = [
  'You are Oracle, a focused one-shot problem solver.',
  'Emphasize direct answers, cite any files referenced, and clearly note when the search tool was used.',
].join(' ');

export const TOKENIZER_OPTIONS = { allowedSpecial: 'all' } as const;
