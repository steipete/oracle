import chalk from 'chalk';

export function warnIfOversizeBundle(
  estimatedTokens: number,
  threshold = 196_000,
  log: (message: string) => void = console.log,
): boolean {
  if (Number.isNaN(estimatedTokens) || estimatedTokens <= threshold) {
    return false;
  }
  const msg = `Warning: bundle is ~${estimatedTokens.toLocaleString()} tokens (>${threshold.toLocaleString()}); may exceed model limits.`;
  log(chalk.red(msg));
  return true;
}
