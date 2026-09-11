import { expect, test } from "vitest";
import {
  browserPromptFingerprint,
  readSubmittedPromptFingerprint,
  readUserMessageIds,
} from "../../src/browser/promptFingerprint.js";
import type { ChromeClient } from "../../src/browser/types.js";

test("captures a new message when earlier turns unmount during submission", async () => {
  const user = (text: string, id: string) => ({ textContent: text, getAttribute: () => id });
  const oldUsers = [user("First", "old-1"), user("Continue", "old-2")];
  let users = oldUsers;
  const runtime = {
    evaluate: async ({ expression }: { expression: string }) => ({
      result: {
        value: new Function("document", `return ${expression}`)({
          querySelectorAll: (selector: string) =>
            selector === '[data-message-author-role="user"]'
              ? users
              : users.map((message) => ({ matches: () => false, querySelector: () => message })),
        }),
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  const previous = await readUserMessageIds(runtime);
  expect(previous).toEqual(["old-1", "old-2"]);
  expect(await readSubmittedPromptFingerprint(runtime, previous)).toBeUndefined();
  users = [oldUsers[1], user("Continue", "current-message")];
  expect(await readSubmittedPromptFingerprint(runtime, previous)).toBe(
    browserPromptFingerprint("Continue", "current-message"),
  );
  expect(await readSubmittedPromptFingerprint(runtime, undefined)).toBeUndefined();
});

test("waits for pre-existing user message IDs to hydrate", async () => {
  let calls = 0;
  const runtime = {
    evaluate: async () => ({ result: { value: ++calls === 1 ? [null] : ["old-message"] } }),
  } as unknown as ChromeClient["Runtime"];
  expect(await readUserMessageIds(runtime, 1000)).toEqual(["old-message"]);
  expect(calls).toBe(2);
});

test("does not confuse an existing identical prompt with the next submission", async () => {
  let calls = 0;
  const runtime = {
    evaluate: async () => ({
      result: {
        value: { text: "Continue", messageId: ++calls === 1 ? "old-message" : "current-message" },
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  expect(await readSubmittedPromptFingerprint(runtime, ["old-message"], 1000)).toBe(
    browserPromptFingerprint("Continue", "current-message"),
  );
  expect(calls).toBe(2);
});

test("fingerprints preserve case and meaningful indentation", () => {
  expect(browserPromptFingerprint("Foo", "current-message")).not.toBe(
    browserPromptFingerprint("foo", "current-message"),
  );
  expect(browserPromptFingerprint("if active:\n  run()\nfinish()", "current-message")).not.toBe(
    browserPromptFingerprint("if active:\n  run()\n  finish()", "current-message"),
  );
  expect(browserPromptFingerprint("one\r\ntwo", "current-message")).toBe(
    browserPromptFingerprint("one\ntwo", "current-message"),
  );
  expect(browserPromptFingerprint("Continue", "old-message")).not.toBe(
    browserPromptFingerprint("Continue", "current-message"),
  );
});

test("preserves committed identity when earlier conversation turns are unmounted", async () => {
  const user = { textContent: "Continue", getAttribute: () => "current-message" };
  const current = { matches: () => false, querySelector: () => user };
  let turns = [
    ...Array.from({ length: 20 }, () => ({ matches: () => false, querySelector: () => null })),
    current,
  ];
  const runtime = {
    evaluate: async ({ expression }: { expression: string }) => ({
      result: {
        value: new Function("document", `return ${expression}`)({ querySelectorAll: () => turns }),
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  const before = await readSubmittedPromptFingerprint(runtime, []);
  turns = [current];
  expect(await readSubmittedPromptFingerprint(runtime, [])).toBe(before);
  expect(before).toBe(browserPromptFingerprint("Continue", "current-message"));
});

test("waits for stable message identity instead of fingerprinting text alone", async () => {
  let calls = 0;
  const runtime = {
    evaluate: async () => ({
      result: { value: { text: "Continue", messageId: ++calls === 1 ? null : "current-message" } },
    }),
  } as unknown as ChromeClient["Runtime"];
  expect(await readSubmittedPromptFingerprint(runtime, [], 1000)).toBe(
    browserPromptFingerprint("Continue", "current-message"),
  );
  expect(calls).toBe(2);
});

test("captures the rendered committed user turn rather than Markdown source", async () => {
  const text = "Heading\nspec\nif active:\n  run()";
  const user = { textContent: text, getAttribute: () => "current-message" };
  const turn = { matches: () => false, querySelector: () => user };
  const runtime = {
    evaluate: async ({ expression }: { expression: string }) => ({
      result: {
        value: new Function("document", `return ${expression}`)({ querySelectorAll: () => [turn] }),
      },
    }),
  } as unknown as ChromeClient["Runtime"];

  await expect(readSubmittedPromptFingerprint(runtime, [])).resolves.toBe(
    browserPromptFingerprint(text, "current-message"),
  );
  await expect(
    readSubmittedPromptFingerprint(runtime, ["current-message"]),
  ).resolves.toBeUndefined();
  expect(browserPromptFingerprint(text, "current-message")).not.toBe(
    browserPromptFingerprint(
      "# Heading\n[spec](https://example.com)\n```python\nif active:\n  run()\n```",
      "current-message",
    ),
  );
});

test("waits for asynchronous user-turn mounting within the configured input timeout", async () => {
  let calls = 0;
  const runtime = {
    evaluate: async () => ({
      result: {
        value: ++calls === 1 ? null : { text: "Mounted user prompt", messageId: "current-message" },
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  await expect(readSubmittedPromptFingerprint(runtime, [], 1000)).resolves.toBe(
    browserPromptFingerprint("Mounted user prompt", "current-message"),
  );
  expect(calls).toBe(2);
});

test("retries a replaced execution context without treating a closed connection as transient", async () => {
  let calls = 0;
  const runtime = {
    evaluate: async () => {
      if (++calls === 1) throw new Error("Protocol error: Execution context was destroyed");
      return { result: { value: { text: "Committed prompt", messageId: "current-message" } } };
    },
  } as unknown as ChromeClient["Runtime"];
  await expect(readSubmittedPromptFingerprint(runtime, [], 1000)).resolves.toBe(
    browserPromptFingerprint("Committed prompt", "current-message"),
  );
  expect(calls).toBe(2);
  calls = 0;
  runtime.evaluate = async () => {
    calls++;
    throw new Error("WebSocket is not open");
  };
  await expect(readSubmittedPromptFingerprint(runtime, [], 1000)).resolves.toBeUndefined();
  expect(calls).toBe(1);
});
