export function formatCompactNumber(value: number): string {
  if (Number.isNaN(value) || !Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  const stripTrailingZero = (text: string) => text.replace(/\.0$/, '');
  if (abs >= 1_000_000) {
    return `${stripTrailingZero((value / 1_000_000).toFixed(1))}m`;
  }
  if (abs >= 1_000) {
    return `${stripTrailingZero((value / 1_000).toFixed(1))}k`;
  }
  return value.toLocaleString();
}
