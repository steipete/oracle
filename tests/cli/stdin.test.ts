import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { readStdin, resolveDashPrompt } from "../../src/cli/stdin.js";

describe("stdin helpers", () => {
  test("readStdin reads the full stream payload", async () => {
    const stream = Readable.from(["Hello", " ", "world"]);
    await expect(readStdin(stream)).resolves.toBe("Hello world");
  });

  test("resolveDashPrompt keeps normal prompts unchanged", async () => {
    await expect(resolveDashPrompt("normal prompt", Readable.from([]))).resolves.toBe(
      "normal prompt",
    );
  });

  test("resolveDashPrompt reads piped stdin", async () => {
    const stream = Readable.from(["Hello world\n"]);
    Object.assign(stream, { isTTY: false });
    await expect(resolveDashPrompt("-", stream)).resolves.toBe("Hello world");
  });

  test("resolveDashPrompt rejects tty stdin", async () => {
    const stream = Readable.from([]);
    Object.assign(stream, { isTTY: true });
    await expect(resolveDashPrompt("-", stream)).rejects.toThrow(/requires piped input/i);
  });

  test("resolveDashPrompt rejects empty stdin", async () => {
    const stream = Readable.from([" \n "]);
    Object.assign(stream, { isTTY: false });
    await expect(resolveDashPrompt("-", stream)).rejects.toThrow(/received empty stdin/i);
  });
});
