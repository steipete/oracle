import chalk from 'chalk';
import kleur from 'kleur';
import { MODEL_CONFIGS } from '../oracle.js';
import type { SessionMetadata } from '../sessionStore.js';
import { estimateUsdCost } from 'tokentally';

const isRich = (rich?: boolean): boolean => rich ?? Boolean(process.stdout.isTTY && chalk.level > 0);
const dim = (text: string, rich: boolean): string => (rich ? kleur.dim(text) : text);

export const STATUS_PAD = 9;
export const MODEL_PAD = 13;
export const MODE_PAD = 7;
export const TIMESTAMP_PAD = 19;
export const CHARS_PAD = 5;
export const COST_PAD = 7;

export function formatSessionTableHeader(rich?: boolean): string {
  const header = `${'Status'.padEnd(STATUS_PAD)} ${'Model'.padEnd(MODEL_PAD)} ${'Mode'.padEnd(
    MODE_PAD,
  )} ${'Timestamp'.padEnd(TIMESTAMP_PAD)} ${'Chars'.padStart(CHARS_PAD)} ${'Cost'.padStart(COST_PAD)}  Slug`;
  return dim(header, isRich(rich));
}

export function formatSessionTableRow(meta: SessionMetadata, options?: { rich?: boolean }): string {
  const rich = isRich(options?.rich);
  const status = colorStatus(meta.status ?? 'unknown', rich);
  const modelLabel = (meta.model ?? 'n/a').padEnd(MODEL_PAD);
  const model = rich ? chalk.white(modelLabel) : modelLabel;
  const modeLabel = (meta.mode ?? meta.options?.mode ?? 'api').padEnd(MODE_PAD);
  const mode = rich ? chalk.gray(modeLabel) : modeLabel;
  const timestampLabel = formatTimestampAligned(meta.createdAt).padEnd(TIMESTAMP_PAD);
  const timestamp = rich ? chalk.gray(timestampLabel) : timestampLabel;
  const charsValue = meta.options?.prompt?.length ?? meta.promptPreview?.length ?? 0;
  const charsRaw = charsValue > 0 ? String(charsValue).padStart(CHARS_PAD) : `${''.padStart(CHARS_PAD - 1)}-`;
  const chars = rich ? chalk.gray(charsRaw) : charsRaw;
  const costValue = resolveSessionCost(meta);
  const costRaw = costValue != null ? formatCostTable(costValue) : `${''.padStart(COST_PAD - 1)}-`;
  const cost = rich ? chalk.gray(costRaw) : costRaw;
  const slug = rich ? chalk.cyan(meta.id) : meta.id;
  return `${status} ${model} ${mode} ${timestamp} ${chars} ${cost}  ${slug}`;
}

export function resolveSessionCost(meta: SessionMetadata): number | null {
  const mode = meta.mode ?? meta.options?.mode;
  if (mode === 'browser') {
    return null;
  }
  if (meta.usage?.cost != null) {
    return meta.usage.cost;
  }
  if (!meta.model || !meta.usage) {
    return null;
  }
  const pricing = MODEL_CONFIGS[meta.model as keyof typeof MODEL_CONFIGS]?.pricing;
  if (!pricing) {
    return null;
  }
  const input = meta.usage.inputTokens ?? 0;
  const output = meta.usage.outputTokens ?? 0;
  const cost =
    estimateUsdCost({
      usage: { inputTokens: input, outputTokens: output },
      pricing: { inputUsdPerToken: pricing.inputPerToken, outputUsdPerToken: pricing.outputPerToken },
    })?.totalUsd ?? 0;
  return cost > 0 ? cost : null;
}

export function formatTimestampAligned(iso: string): string {
  const date = new Date(iso);
  const locale = 'en-US';
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: undefined,
    hour12: true,
  };
  let formatted = date.toLocaleString(locale, opts);
  formatted = formatted.replace(', ', '  ');
  return formatted.replace(/(\s)(\d:)/, '$1 $2');
}

function formatCostTable(cost: number): string {
  return `$${cost.toFixed(3)}`.padStart(COST_PAD);
}

function colorStatus(status: string, rich: boolean): string {
  const padded = status.padEnd(STATUS_PAD);
  if (!rich) {
    return padded;
  }
  switch (status) {
    case 'completed':
      return chalk.green(padded);
    case 'error':
      return chalk.red(padded);
    case 'running':
      return chalk.yellow(padded);
    default:
      return padded;
  }
}
