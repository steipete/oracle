import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { assembleBrowserPrompt, cleanupGeneratedBrowserBundles } from "../../src/browser/prompt.js";
import { runBrowserSessionExecution } from "../../src/browser/sessionRunner.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bundle-lifecycle-"));
  const file = ["one.ts", "two.ts", "attachments-bundle.zip", "attachments-bundle-2.zip"];
  await Promise.all(file.map((name) => fs.writeFile(path.join(root, name), name)));
  return { root, file };
}

test("generated ZIP names avoid native attachments and match extraction instructions", async () => {
  const { root, file } = await fixture();
  try {
    const artifacts = await assembleBrowserPrompt(
      { prompt: "inspect", model: "gpt-5.5", file, browserAttachments: "always" },
      { cwd: root },
    );
    try {
      expect(artifacts.attachments.map((a) => path.basename(a.path))).toEqual([
        "attachments-bundle-3.zip",
        "attachments-bundle.zip",
        "attachments-bundle-2.zip",
      ]);
      expect(artifacts.composerText).toContain("`attachments-bundle-3.zip`");
      expect(await fs.readFile(artifacts.attachments[1]!.path, "utf8")).toBe(
        "attachments-bundle.zip",
      );
    } finally {
      await cleanupGeneratedBrowserBundles(artifacts);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("prompt preparation that finishes after timeout still releases its generated bundle", async () => {
  const { root, file } = await fixture();
  const artifacts = await assembleBrowserPrompt(
    { prompt: "inspect", model: "gpt-5.5", file, browserAttachments: "always" },
    { cwd: root },
  );
  const generated = path.dirname(artifacts.bundled!.bundlePath);
  const executeBrowser = vi.fn();
  let finish!: (value: typeof artifacts) => void;
  const pending = new Promise<typeof artifacts>((resolve) => {
    finish = resolve;
  });
  try {
    await expect(
      runBrowserSessionExecution(
        {
          runOptions: { prompt: "inspect", model: "gpt-5.5" },
          browserConfig: { inputTimeoutMs: 10 },
          cwd: root,
          log: () => {},
        },
        { assemblePrompt: () => pending, executeBrowser },
      ),
    ).rejects.toMatchObject({ details: { code: "prompt-preparation-timeout" } });
    finish(artifacts);
    await vi.waitFor(async () => {
      await expect(fs.access(generated)).rejects.toMatchObject({ code: "ENOENT" });
    });
    expect(executeBrowser).not.toHaveBeenCalled();
  } finally {
    finish(artifacts);
    await cleanupGeneratedBrowserBundles(artifacts);
    await fs.rm(root, { recursive: true, force: true });
  }
});
