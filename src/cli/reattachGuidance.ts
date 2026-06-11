export function formatBrowserReattachGuidance(sessionId: string): string {
  return [
    "This run did not return cleanly, but it may still be alive. Reattach:",
    `  oracle session ${sessionId} --render    # final markdown when complete`,
    `  oracle session ${sessionId} --live      # tail until done`,
    `  oracle session ${sessionId} --harvest   # snapshot the current answer now`,
  ].join("\n");
}
