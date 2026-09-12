import { createHash } from "node:crypto";
import type { ChromeClient } from "./types.js";
import { buildConversationTurnListExpression } from "./conversationTurns.js";

export function browserPromptFingerprint(value: unknown, messageId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([messageId, String(value ?? "").replace(/\r\n?/g, "\n")]))
    .digest("hex");
}

export function readUserMessageIds(
  runtime: ChromeClient["Runtime"],
  timeoutMs = 0,
): Promise<string[] | undefined> {
  return readDomUntil(
    runtime,
    `Array.from(document.querySelectorAll('[data-message-author-role="user"]'), user => user.getAttribute('data-message-id'))`,
    timeoutMs,
    (value) =>
      Array.isArray(value) && value.every((id) => typeof id === "string" && id.trim())
        ? (value as string[])
        : undefined,
  );
}

export async function readSubmittedPromptFingerprint(
  runtime: ChromeClient["Runtime"],
  previousMessageIds: readonly string[] | undefined,
  timeoutMs = 0,
): Promise<string | undefined> {
  if (previousMessageIds === undefined) return undefined;
  const previous = new Set(previousMessageIds);
  return readDomUntil(
    runtime,
    `(() => {
        const turns = ${buildConversationTurnListExpression()};
        for (let index = turns.length - 1; index >= 0; index--) {
          const turn = turns[index];
          const user = turn.matches('[data-message-author-role="user"]') ? turn : turn.querySelector('[data-message-author-role="user"]');
          if (user) return { text: user.textContent, messageId: user.getAttribute('data-message-id') };
        }
        return null;
      })()`,
    timeoutMs,
    (value) => {
      const turn = value as { text?: unknown; messageId?: unknown } | null;
      if (
        typeof turn?.text === "string" &&
        turn.text.trim() &&
        typeof turn.messageId === "string" &&
        turn.messageId.trim() &&
        !previous.has(turn.messageId)
      )
        return browserPromptFingerprint(turn.text, turn.messageId);
      return undefined;
    },
  );
}

async function readDomUntil<T>(
  runtime: ChromeClient["Runtime"],
  expression: string,
  timeoutMs: number,
  select: (value: unknown) => T | undefined,
): Promise<T | undefined> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      const result = await runtime.evaluate({ expression, returnByValue: true });
      const selected = select(result.result?.value);
      if (selected !== undefined) return selected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !/Cannot find (?:default )?(?:execution )?context|Execution context (?:was destroyed|is not available)/i.test(
          message,
        )
      )
        return undefined;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
}
