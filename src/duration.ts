export function parseDuration(input: string, fallback: number): number {
  if (!input) {
    return fallback;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return fallback;
  }
  const lowercase = trimmed.toLowerCase();
  if (/^[0-9]+$/.test(lowercase)) {
    return Number(lowercase);
  }
  const normalized = lowercase.replace(/\s+/g, "");
  const singleMatch = /^([0-9]+)(ms|s|m|h)$/i.exec(normalized);
  if (singleMatch && singleMatch[0].length === normalized.length) {
    const value = Number(singleMatch[1]);
    return convertUnit(value, singleMatch[2]);
  }
  const multiDuration = /([0-9]+)(ms|h|m|s)/g;
  let total = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null = multiDuration.exec(normalized);
  while (match !== null) {
    total += convertUnit(Number(match[1]), match[2]);
    lastIndex = multiDuration.lastIndex;
    match = multiDuration.exec(normalized);
  }
  if (total > 0 && lastIndex === normalized.length) {
    return total;
  }
  return fallback;
}

function convertUnit(value: number, unitRaw: string | undefined): number {
  const unit = unitRaw?.toLowerCase();
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return value;
  }
}
