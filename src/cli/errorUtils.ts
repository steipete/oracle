const LOGGED_SYMBOL = Symbol("oracle.alreadyLogged");

export function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.trim()) return message;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (typeof code === "string" && code.trim()) return `Operation failed (${code}).`;
  return "An unexpected error occurred. Retry with --verbose for more details.";
}

export function markErrorLogged(error: unknown): void {
  if (error instanceof Error) {
    (error as Error & { [LOGGED_SYMBOL]?: true })[LOGGED_SYMBOL] = true;
  }
}

export function isErrorLogged(error: unknown): boolean {
  return Boolean(
    error instanceof Error && (error as Error & { [LOGGED_SYMBOL]?: true })[LOGGED_SYMBOL],
  );
}
