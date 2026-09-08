import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import { createRemoteServer } from "../../src/remote/server.js";
import type { RemoteRunPayload } from "../../src/remote/types.js";

const result = {
  answerText: "ok",
  answerMarkdown: "ok",
  tookMs: 1,
  answerTokens: 1,
  answerChars: 2,
};
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-remote-bundle-"));
  const attachments = await Promise.all(
    Array.from({ length: 11 }, async (_, i) => {
      const file = path.join(root, `source-${i}.ts`);
      await fs.writeFile(file, `source-${i}`);
      return { path: file, displayPath: `source-${i}.ts`, sizeBytes: 10 };
    }),
  );
  return { root, attachments };
}

test.each([404, 200])(
  "prepares a compatible one-file fallback for an old host (health %i)",
  async (healthStatus) => {
    const { root, attachments } = await fixture();
    let received: RemoteRunPayload | undefined;
    const server = http.createServer(async (req, res) => {
      if (req.url === "/health") {
        res.writeHead(healthStatus);
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = JSON.parse(Buffer.concat(chunks).toString());
      res.end(`${JSON.stringify({ type: "result", result })}\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      await createRemoteBrowserExecutor({ host: `127.0.0.1:${address.port}`, token: "test" })({
        prompt: "inline",
        config: {},
        fallbackSubmission: {
          prompt: "fallback",
          attachments,
          pendingBundle: { format: "zip", scope: "all" },
        },
      });
      expect(received?.fallbackSubmission?.bundle).toBeUndefined();
      expect(received?.fallbackSubmission?.attachments).toHaveLength(1);
      const bundle = received!.fallbackSubmission!.attachments[0]!;
      expect(Buffer.from(bundle.contentBase64, "base64").subarray(0, 2).toString()).toBe("PK");
      expect(received?.fallbackSubmission?.prompt).toContain(`\`${bundle.fileName}\``);
      await expect(fs.access(path.dirname(bundle.displayPath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test.each([false, true])(
  "remote deferred bundles stay run-owned after success/error (error=%s)",
  async (fail) => {
    const { root, attachments } = await fixture();
    let generated: string | undefined;
    const server = await createRemoteServer(
      { host: "127.0.0.1", port: 0, token: "test", logger: () => {} },
      {
        runBrowser: async (options) => {
          const fallback = options.fallbackSubmission!;
          expect(fallback.attachments).toHaveLength(11);
          const runDir = path.dirname(path.dirname(fallback.attachments[0]!.path));
          await Promise.all([fallback.prepare!(), fallback.prepare!()]);
          expect(fallback.attachments).toHaveLength(1);
          generated = path.dirname(fallback.attachments[0]!.path);
          expect(path.dirname(generated)).toBe(runDir);
          expect(
            (await fs.readdir(runDir)).filter((f) => f.startsWith("oracle-browser-bundle-")),
          ).toHaveLength(1);
          expect(await fs.readFile(fallback.attachments[0]!.path, "utf8")).toContain("source-10");
          if (fail) throw new Error("synthetic run failure");
          return result;
        },
      },
    );
    try {
      const run = createRemoteBrowserExecutor({ host: `127.0.0.1:${server.port}`, token: "test" })({
        prompt: "inline",
        config: {},
        fallbackSubmission: {
          prompt: "fallback",
          attachments,
          pendingBundle: { format: "text", scope: "text-only" },
        },
      });
      if (fail) await expect(run).rejects.toThrow("synthetic run failure");
      else expect((await run).answerText).toBe("ok");
      expect(generated).toBeDefined();
      await vi.waitFor(async () => {
        await expect(fs.access(generated!)).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
