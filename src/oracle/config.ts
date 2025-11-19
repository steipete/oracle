import { countTokens as countTokensGpt5 } from 'gpt-tokenizer/model/gpt-5';
import { countTokens as countTokensGpt5Pro } from 'gpt-tokenizer/model/gpt-5-pro';
import type { ModelConfig, ModelName, ProModelName, TokenizerFn } from './types.js';

export const DEFAULT_MODEL: ModelName = 'gpt-5.1-pro';
export const PRO_MODELS = new Set<ProModelName>(['gpt-5.1-pro', 'gpt-5-pro']);

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
  },
};

export const DEFAULT_SYSTEM_PROMPT = [
  'You are Oracle, a focused one-shot problem solver.',
  'Emphasize direct answers, cite any files referenced, and clearly note when the search tool was used.',
].join(' ');

export const TOKENIZER_OPTIONS = { allowedSpecial: 'all' } as const;
