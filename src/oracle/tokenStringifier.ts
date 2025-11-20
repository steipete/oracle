// Minimal helper to stringify arbitrary input for tokenizer consumption.
// Anthropic's tokenizer expects a string; we accept unknown and coerce safely.
export function stringifyTokenizerInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input === null || input === undefined) return '';
  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    return String(input);
  }
  if (typeof input === 'object') {
    try {
      return JSON.stringify(input);
    } catch {
      // fall through to generic stringification
    }
  }
  if (typeof input === 'function') {
    return input.toString();
  }
  return String(input);
}

export default stringifyTokenizerInput;
