import type { BrowserModelStrategy } from './types.js';

export function normalizeBrowserModelStrategy(
  value: string | null | undefined,
): BrowserModelStrategy | undefined {
  if (value == null) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'select' || normalized === 'current' || normalized === 'ignore') {
    return normalized as BrowserModelStrategy;
  }
  throw new Error(
    `Invalid browser model strategy: "${value}". Expected "select", "current", or "ignore".`,
  );
}
