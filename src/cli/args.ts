export function splitShellLikeArgs(
  input: string,
  options: { optionName?: string } = {},
): string[] {
  const label = options.optionName ?? "argument string";
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let tokenStarted = false;

  const push = () => {
    if (tokenStarted) {
      args.push(current);
    }
    current = "";
    tokenStarted = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? "";
    if (escaped) {
      current += ch;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (ch === "\0") {
      throw new Error(`${label} cannot contain NUL bytes.`);
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      tokenStarted = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(ch)) {
      push();
      continue;
    }
    current += ch;
    tokenStarted = true;
  }

  if (escaped) {
    throw new Error(`${label} ends with an unfinished escape.`);
  }
  if (quote) {
    const quoteName = quote === "'" ? "single" : "double";
    throw new Error(`${label} has an unterminated ${quoteName} quote.`);
  }
  push();
  return args;
}
