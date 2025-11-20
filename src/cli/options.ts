import { InvalidArgumentError, type Command } from 'commander';
import type { ModelName, PreviewMode } from '../oracle.js';
import { DEFAULT_MODEL, MODEL_CONFIGS } from '../oracle.js';

export function collectPaths(value: string | string[] | undefined, previous: string[] = []): string[] {
  if (!value) {
    return previous;
  }
  const nextValues = Array.isArray(value) ? value : [value];
  return previous.concat(nextValues.flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean));
}

/**
 * Merge all path-like CLI inputs (file/include aliases) into a single list, preserving order.
 */
export function mergePathLikeOptions(
  file?: string[],
  include?: string[],
  filesAlias?: string[],
  pathAlias?: string[],
  pathsAlias?: string[],
): string[] {
  const withFile = collectPaths(file, []);
  const withInclude = collectPaths(include, withFile);
  const withFilesAlias = collectPaths(filesAlias, withInclude);
  const withPathAlias = collectPaths(pathAlias, withFilesAlias);
  return collectPaths(pathsAlias, withPathAlias);
}

export function collectModelList(value: string, previous: string[] = []): string[] {
  if (!value) {
    return previous;
  }
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return previous.concat(entries);
}

export function parseFloatOption(value: string): number {
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new InvalidArgumentError('Value must be a number.');
  }
  return parsed;
}

export function parseIntOption(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new InvalidArgumentError('Value must be an integer.');
  }
  return parsed;
}

export function parseHeartbeatOption(value: string | number | undefined): number {
  if (value == null) {
    return 30;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value) || value < 0) {
      throw new InvalidArgumentError('Heartbeat interval must be zero or a positive number.');
    }
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return 30;
  }
  if (normalized === 'false' || normalized === 'off') {
    return 0;
  }
  const parsed = Number.parseFloat(normalized);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Heartbeat interval must be zero or a positive number.');
  }
  return parsed;
}

export function usesDefaultStatusFilters(cmd: Command): boolean {
  const hoursSource = cmd.getOptionValueSource?.('hours') ?? 'default';
  const limitSource = cmd.getOptionValueSource?.('limit') ?? 'default';
  const allSource = cmd.getOptionValueSource?.('all') ?? 'default';
  return hoursSource === 'default' && limitSource === 'default' && allSource === 'default';
}

export function resolvePreviewMode(value: boolean | string | undefined): PreviewMode | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value as PreviewMode;
  }
  if (value === true) {
    return 'summary';
  }
  return undefined;
}

export function parseSearchOption(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(normalized)) {
    return true;
  }
  if (['off', 'false', '0', 'no'].includes(normalized)) {
    return false;
  }
  throw new InvalidArgumentError('Search mode must be "on" or "off".');
}

export function normalizeModelOption(value: string | undefined): string {
  return (value ?? '').trim();
}

export function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
}

export function parseTimeoutOption(value: string | undefined): number | 'auto' | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  const parsed = Number.parseFloat(normalized);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Timeout must be a positive number of seconds or "auto".');
  }
  return parsed;
}

export function resolveApiModel(modelValue: string): ModelName {
  const normalized = normalizeModelOption(modelValue).toLowerCase();
  if (normalized in MODEL_CONFIGS) {
    return normalized as ModelName;
  }
  if (normalized.includes('claude') && normalized.includes('sonnet')) {
    return 'claude-4.5-sonnet';
  }
  if (normalized.includes('claude') && normalized.includes('opus')) {
    return 'claude-4.1-opus';
  }
  if (normalized.includes('5.0') || normalized === 'gpt-5-pro' || normalized === 'gpt-5') {
    return 'gpt-5-pro';
  }
  if (normalized.includes('5-pro') && !normalized.includes('5.1')) {
    return 'gpt-5-pro';
  }
  if (normalized.includes('5.1') && normalized.includes('pro')) {
    return 'gpt-5.1-pro';
  }
  if (normalized.includes('codex')) {
    if (normalized.includes('max')) {
      throw new InvalidArgumentError('gpt-5.1-codex-max is not available yet. OpenAI has not released the API.');
    }
    return 'gpt-5.1-codex';
  }
  if (normalized.includes('gemini')) {
    return 'gemini-3-pro';
  }
  throw new InvalidArgumentError(
    `Unsupported model "${modelValue}". Choose one of: ${Object.keys(MODEL_CONFIGS).join(', ')}`,
  );
}

export function inferModelFromLabel(modelValue: string): ModelName {
  const normalized = normalizeModelOption(modelValue).toLowerCase();
  if (!normalized) {
    return DEFAULT_MODEL;
  }
  if (normalized in MODEL_CONFIGS) {
    return normalized as ModelName;
  }
  if (normalized.includes('claude') && normalized.includes('sonnet')) {
    return 'claude-4.5-sonnet';
  }
  if (normalized.includes('claude') && normalized.includes('opus')) {
    return 'claude-4.1-opus';
  }
  if (normalized.includes('5.0') || normalized.includes('5-pro')) {
    return 'gpt-5-pro';
  }
  if (normalized.includes('gpt-5') && normalized.includes('pro') && !normalized.includes('5.1')) {
    return 'gpt-5-pro';
  }
  if (normalized.includes('codex')) {
    return 'gpt-5.1-codex';
  }
  if (normalized.includes('gemini')) {
    return 'gemini-3-pro';
  }
  if (normalized.includes('classic')) {
    return 'gpt-5.1-pro';
  }
  if ((normalized.includes('5.1') || normalized.includes('5_1')) && normalized.includes('pro')) {
    return 'gpt-5.1-pro';
  }
  if (normalized.includes('pro')) {
    return 'gpt-5.1-pro';
  }
  if (normalized.includes('5.1') || normalized.includes('5_1')) {
    return 'gpt-5.1';
  }
  if (normalized.includes('instant') || normalized.includes('thinking') || normalized.includes('fast')) {
    return 'gpt-5.1';
  }
  return 'gpt-5.1';
}
