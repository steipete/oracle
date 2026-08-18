import { describe, expect, test } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { createRemoteServer, RunSlots } from "../../src/remote/server.js";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import type { BrowserRunResult } from "../../src/browserMode.js";
import type { RemoteArtifactDescriptor } from "../../src/remote/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

const CAN_LISTEN_LOCALHOST =
  spawnSync(
    process.execPath,
    [
      "-e",
      `
      const net = require('net');
      const s = net.createServer();
      s.on('error', () => process.exit(1));
      s.listen(0, '127.0.0.1', () => s.close(() => process.exit(0)));
    `,
    ],
    { stdio: "ignore" },
  ).status === 0;

describe("remote browser service", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "streams logs and returns results via client executor",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-test-"));
      const attachmentPath = path.join(tmpDir, "note.txt");
      const fallbackAttachmentPath = path.join(tmpDir, "fallback.txt");
      await writeFile(attachmentPath, "hello world", "utf8");
      await writeFile(fallbackAttachmentPath, "fallback world", "utf8");

      const runLog: string[] = [];
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async (options) => {
            runLog.push(options.prompt);
            expect(options.config?.cookieSync).toBe(false);
            // The server namespaces the client's slug per run so two callers
            // cannot share an artifact directory; the caller's slug stays as the
            // prefix, and the client re-saves what it pulls under its own session.
            expect(options.sessionId).toMatch(/^remote-session-id-[0-9a-f]{8}$/);
            expect(options.followUpPrompts).toEqual(["follow up"]);
            expect(options.attachments).toHaveLength(1);
            const attachment = options.attachments?.[0];
            if (!attachment) {
              throw new Error("missing attachment");
            }
            const stored = await readFile(attachment.path, "utf8");
            expect(stored).toBe("hello world");
            expect(options.fallbackSubmission?.prompt).toBe("fallback prompt");
            expect(options.fallbackSubmission?.attachments).toHaveLength(1);
            const fallbackAttachment = options.fallbackSubmission?.attachments[0];
            if (!fallbackAttachment) {
              throw new Error("missing fallback attachment");
            }
            const fallbackStored = await readFile(fallbackAttachment.path, "utf8");
            expect(fallbackStored).toBe("fallback world");
            options.log?.("uploading attachment");
            const result: BrowserRunResult = {
              answerText: "hi",
              answerMarkdown: "hi",
              tookMs: 1000,
              answerTokens: 42,
              answerChars: 2,
            };
            return result;
          },
        },
      );

      const executor = createRemoteBrowserExecutor({
        host: `127.0.0.1:${server.port}`,
        token: "secret",
      });
      const clientLogs: string[] = [];
      const result = await executor({
        prompt: "remote",
        attachments: [{ path: attachmentPath, displayPath: "note.txt", sizeBytes: 11 }],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [
            { path: fallbackAttachmentPath, displayPath: "fallback.txt", sizeBytes: 14 },
          ],
        },
        config: {},
        sessionId: "remote-session-id",
        followUpPrompts: ["follow up"],
        log: (message?: string) => {
          if (message) clientLogs.push(message);
        },
      });

      expect(clientLogs.some((entry) => entry.includes("uploading attachment"))).toBe(true);
      expect(result.answerText).toBe("hi");
      expect(runLog).toEqual(["remote"]);

      const healthUnauthorized = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/health",
      });
      expect(healthUnauthorized.statusCode).toBe(401);

      const healthOk = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/health",
        token: "secret",
      });
      expect(healthOk.statusCode).toBe(200);
      expect(healthOk.json?.ok).toBe(true);
      expect(typeof healthOk.json?.version).toBe("string");
      expect(healthOk.json?.capabilities).toMatchObject({
        artifactTransfer: true,
        artifactProtocolVersion: 1,
      });

      const artifactUnauthorized = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/runs/run-id/artifacts/artifact-id",
      });
      expect(artifactUnauthorized.statusCode).toBe(401);

      const malformedArtifactPath = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/runs/%E0%A4%A/artifacts/artifact-id",
        token: "secret",
      });
      expect(malformedArtifactPath.statusCode).toBe(404);

      const healthAfterMalformedPath = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/health",
        token: "secret",
      });
      expect(healthAfterMalformedPath.statusCode).toBe(200);

      await server.close();
      await rm(tmpDir, { recursive: true, force: true });
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps manual-login Chrome but requests completed run-tab cleanup",
    async () => {
      const manualLoginProfileDir = "/tmp/oracle-manual-login-profile-test";
      const cleanupPolicies: Array<boolean | undefined> = [];
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          manualLoginDefault: true,
          manualLoginProfileDir,
        },
        {
          runBrowser: async (options) => {
            expect(options.config).toMatchObject({
              manualLogin: true,
              manualLoginProfileDir,
              keepBrowser: true,
              cookieSync: false,
            });
            cleanupPolicies.push(options.closeOwnedTabOnComplete);
            return {
              answerText: "done",
              answerMarkdown: "done",
              tookMs: 1,
              answerTokens: 1,
              answerChars: 4,
            };
          },
        },
      );

      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        });
        const result = await executor({
          prompt: "remote manual-login cleanup",
          config: {},
        });

        expect(result.answerText).toBe("done");

        const explicitlyKept = await executor({
          prompt: "remote manual-login explicit keep",
          config: { keepBrowser: true },
        });

        expect(explicitlyKept.answerText).toBe("done");
        expect(cleanupPolicies).toEqual([true, false]);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "transfers saved browser file artifacts to the client session directory",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-test-"));
      const clientHome = path.join(tmpDir, "client-home");
      setOracleHomeDirOverrideForTest(clientHome);
      const hostArtifactPath = path.join(
        clientHome,
        "sessions",
        "host-session",
        "artifacts",
        "host-result.zip",
      );
      const hostPrivatePath = path.join(tmpDir, "host-private.zip");
      const secondHostArtifactPath = path.join(
        clientHome,
        "sessions",
        "second-host-session",
        "artifacts",
        "host-result.zip",
      );
      const emptyZip = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      await mkdir(path.dirname(hostArtifactPath), { recursive: true });
      await mkdir(path.dirname(secondHostArtifactPath), { recursive: true });
      await writeFile(hostArtifactPath, emptyZip);
      await writeFile(secondHostArtifactPath, emptyZip);
      await writeFile(hostPrivatePath, emptyZip);

      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async () => {
            const result: BrowserRunResult = {
              answerText: "done",
              answerMarkdown: "done",
              tookMs: 1000,
              answerTokens: 1,
              answerChars: 4,
              savedFiles: [
                {
                  kind: "file",
                  path: hostArtifactPath,
                  label: "Download",
                  mimeType: "application/octet-stream",
                  sizeBytes: emptyZip.length,
                  sourceUrl: "sandbox:/mnt/data/result.zip",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: "result.zip",
                },
                {
                  kind: "file",
                  path: secondHostArtifactPath,
                  label: "Download another result",
                  mimeType: "application/zip",
                  sizeBytes: emptyZip.length,
                  sourceUrl: "sandbox:/mnt/data/result.zip",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: "result.zip",
                },
                {
                  kind: "file",
                  path: hostPrivatePath,
                  label: "Private download",
                  mimeType: "application/zip",
                  sizeBytes: emptyZip.length,
                  sourceUrl: "sandbox:/mnt/data/private.zip",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: "private.zip",
                },
              ],
              artifacts: [
                {
                  kind: "file",
                  path: hostArtifactPath,
                  label: "result.zip",
                  mimeType: "application/zip",
                  sizeBytes: emptyZip.length,
                  sourceUrl: "sandbox:/mnt/data/result.zip",
                },
              ],
              warnings: [
                {
                  code: "chatgpt-ui-warning",
                  severity: "warning",
                  message: "host-only warning /Users/private/profile",
                },
              ],
            };
            return result;
          },
        },
      );

      const executor = createRemoteBrowserExecutor({
        host: `127.0.0.1:${server.port}`,
        token: "secret",
      });
      const result = await executor({
        prompt: "remote",
        config: {},
        sessionId: "remote-artifact-session",
      });

      expect(result.answerText).toBe("done");
      expect(result.warnings).toEqual([
        {
          code: "remote-artifact-registration-failed",
          severity: "warning",
          message: expect.stringContaining("could not prepare host-private.zip for transfer"),
        },
      ]);
      expect(JSON.stringify(result)).not.toContain(hostPrivatePath);
      expect(JSON.stringify(result)).not.toContain("host-only warning /Users/private/profile");
      expect(result.artifacts).toHaveLength(2);
      const artifact = result.artifacts?.[0];
      expect(artifact?.path).toBe(
        path.join(
          clientHome,
          "sessions",
          "remote-artifact-session",
          "artifacts",
          "host-result.zip",
        ),
      );
      expect(artifact?.path).not.toBe(hostArtifactPath);
      expect(artifact).toMatchObject({
        kind: "file",
        label: "host-result.zip",
        mimeType: "application/octet-stream",
        sizeBytes: emptyZip.length,
        sourceUrl: "bridge-artifact",
        validation: { type: "zip", ok: true },
        transfer: { status: "completed", bytes: emptyZip.length },
        origin: { mode: "bridge" },
      });
      expect(artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
      await expect(readFile(artifact!.path)).resolves.toEqual(emptyZip);
      const duplicate = result.artifacts?.[1];
      expect(duplicate).toMatchObject({
        kind: "file",
        path: path.join(
          clientHome,
          "sessions",
          "remote-artifact-session",
          "artifacts",
          "host-result-2.zip",
        ),
        label: "host-result-2.zip",
        filename: "host-result-2.zip",
      });
      await expect(readFile(duplicate!.path)).resolves.toEqual(emptyZip);
      await expect(stat(hostArtifactPath)).resolves.toMatchObject({ size: emptyZip.length });
      await expect(stat(secondHostArtifactPath)).resolves.toMatchObject({
        size: emptyZip.length,
      });
      await expect(stat(hostPrivatePath)).resolves.toMatchObject({ size: emptyZip.length });
      await expect(
        stat(
          path.join(clientHome, "sessions", "remote-artifact-session", "artifacts", "private.zip"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await server.close();
      await rm(tmpDir, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "rejects untrusted artifact identifiers before creating local paths",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-invalid-artifact-"));
      setOracleHomeDirOverrideForTest(tmpDir);
      const payload = Buffer.from("zip");
      const bridge = await createFakeArtifactBridge({
        descriptor: createArtifactDescriptor(payload, { artifactId: "../../escape" }),
        payload,
      });

      try {
        const result = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${bridge.port}`,
          token: "secret",
        })({ prompt: "remote", config: {}, sessionId: "invalid-artifact-session" });

        expect(result.savedFiles).toBeUndefined();
        expect(result.warnings).toEqual([
          expect.objectContaining({
            code: "remote-artifact-transfer-failed",
            message: expect.stringContaining("invalid bridge artifact descriptor"),
          }),
        ]);
        expect(bridge.artifactRequests()).toBe(0);
      } finally {
        await bridge.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "stops chunked artifact downloads that exceed the declared size",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-oversize-artifact-"));
      setOracleHomeDirOverrideForTest(tmpDir);
      const declared = Buffer.from("zip");
      const bridge = await createFakeArtifactBridge({
        descriptor: createArtifactDescriptor(declared),
        payload: Buffer.from("zip plus undeclared bytes"),
      });

      try {
        const result = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${bridge.port}`,
          token: "secret",
        })({ prompt: "remote", config: {}, sessionId: "oversize-artifact-session" });

        expect(result.savedFiles).toBeUndefined();
        expect(result.warnings).toEqual([
          expect.objectContaining({
            code: "remote-artifact-transfer-failed",
            message: expect.stringContaining("artifact exceeded declared size"),
          }),
        ]);
        expect(bridge.artifactRequests()).toBe(1);
        const artifactDir = path.join(tmpDir, "sessions", "oversize-artifact-session", "artifacts");
        expect(await readdir(artifactDir).catch(() => [])).toEqual([]);
      } finally {
        await bridge.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );
});

function createArtifactDescriptor(
  payload: Buffer,
  overrides: Partial<RemoteArtifactDescriptor> = {},
): RemoteArtifactDescriptor {
  return {
    artifactId: "artifact-id",
    runId: "run-id",
    kind: "file",
    filename: "result.zip",
    mimeType: "application/zip",
    byteSize: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
    sourceUrlKind: "sandbox",
    transferStatus: "ready",
    ...overrides,
  };
}

async function createFakeArtifactBridge({
  descriptor,
  payload,
}: {
  descriptor: RemoteArtifactDescriptor;
  payload: Buffer;
}): Promise<{
  port: number;
  artifactRequests(): number;
  close(): Promise<void>;
}> {
  let artifactRequestCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/runs") {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(
        `${JSON.stringify({ type: "artifact-ready", runId: descriptor.runId, artifact: descriptor })}\n`,
      );
      res.end(
        `${JSON.stringify({
          type: "result",
          result: {
            answerText: "done",
            answerMarkdown: "done",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
          },
        })}\n`,
      );
      return;
    }
    if (
      req.method === "GET" &&
      req.url ===
        `/runs/${encodeURIComponent(descriptor.runId)}/artifacts/${encodeURIComponent(descriptor.artifactId)}`
    ) {
      artifactRequestCount += 1;
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "X-Oracle-Artifact-Sha256": descriptor.sha256,
      });
      res.write(payload);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake artifact bridge did not bind a TCP port");
  }
  return {
    port: address.port,
    artifactRequests: () => artifactRequestCount,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function httpGetJson({
  hostname,
  port,
  path,
  token,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
}): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname,
        port,
        path,
        method: "GET",
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      },
      (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          const statusCode = res.statusCode ?? 0;
          let json: Record<string, unknown> | null = null;
          try {
            const parsed = body.length ? JSON.parse(body) : null;
            json =
              parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("run admission", () => {
  // The required semantics, stated as tests: four conversations may be active at
  // once, the fifth caller WAITS rather than being refused, refusal is reserved
  // for a full queue, and giving up frees whatever the caller was holding.
  const noSignal = undefined;

  test("admits up to the limit immediately", async () => {
    const slots = new RunSlots(4, 8);
    const releases = await Promise.all([
      slots.acquire(noSignal),
      slots.acquire(noSignal),
      slots.acquire(noSignal),
      slots.acquire(noSignal),
    ]);
    expect(slots.activeCount).toBe(4);
    expect(slots.queuedCount).toBe(0);
    for (const release of releases) release();
    expect(slots.activeCount).toBe(0);
  });

  test("the caller past the limit waits instead of failing", async () => {
    const slots = new RunSlots(4, 8);
    const held = await Promise.all([
      slots.acquire(noSignal),
      slots.acquire(noSignal),
      slots.acquire(noSignal),
      slots.acquire(noSignal),
    ]);

    let fifthAdmitted = false;
    const fifth = slots.acquire(noSignal).then((release) => {
      fifthAdmitted = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fifthAdmitted).toBe(false);
    expect(slots.queuedCount).toBe(1);
    expect(slots.positionFor()).toBe(2);

    held[0]();
    const fifthRelease = await fifth;
    expect(fifthAdmitted).toBe(true);
    expect(slots.activeCount).toBe(4);

    fifthRelease();
    for (const release of held.slice(1)) release();
    expect(slots.activeCount).toBe(0);
  });

  test("the queue is FIFO", async () => {
    const slots = new RunSlots(1, 8);
    const first = await slots.acquire(noSignal);
    const order: number[] = [];
    const second = slots.acquire(noSignal).then((release) => {
      order.push(2);
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = slots.acquire(noSignal).then((release) => {
      order.push(3);
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    first();
    (await second)();
    (await third)();
    expect(order).toEqual([2, 3]);
  });

  test("saturation is only reached when the queue is full too", async () => {
    const slots = new RunSlots(2, 1);
    const held = [await slots.acquire(noSignal), await slots.acquire(noSignal)];
    expect(slots.isSaturated).toBe(false);
    const queued = slots.acquire(noSignal);
    expect(slots.isSaturated).toBe(true);
    held[0]();
    (await queued)();
    held[1]();
  });

  test("a caller that gives up while queued frees its place", async () => {
    // Without this a long-lived service leaks capacity to clients that walked
    // away, until it stops accepting work at all.
    const slots = new RunSlots(1, 8);
    const held = await slots.acquire(noSignal);
    const controller = new AbortController();
    const abandoned = slots.acquire(controller.signal);
    expect(slots.queuedCount).toBe(1);

    controller.abort();
    await expect(abandoned).rejects.toThrow(/cancelled while waiting/);
    expect(slots.queuedCount).toBe(0);

    held();
    const next = await slots.acquire(noSignal);
    expect(slots.activeCount).toBe(1);
    next();
  });

  test("an already-cancelled caller never takes a slot", async () => {
    const slots = new RunSlots(4, 8);
    const controller = new AbortController();
    controller.abort();
    await expect(slots.acquire(controller.signal)).rejects.toThrow(/cancelled before/);
    expect(slots.activeCount).toBe(0);
  });

  test("releasing twice does not hand out capacity that does not exist", async () => {
    const slots = new RunSlots(2, 8);
    const release = await slots.acquire(noSignal);
    release();
    release();
    expect(slots.activeCount).toBe(0);
  });
});

describe("bridge concurrency end to end", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "two callers run concurrently and a third waits for a slot",
    async () => {
      let active = 0;
      let peakActive = 0;
      const finish: (() => void)[] = [];
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          maxConcurrentRuns: 2,
          maxQueuedRuns: 4,
        },
        {
          runBrowser: async () => {
            active += 1;
            peakActive = Math.max(peakActive, active);
            await new Promise<void>((resolve) => finish.push(resolve));
            active -= 1;
            return {
              answerText: "ok",
              answerMarkdown: "ok",
              tookMs: 1,
              answerTokens: 1,
              answerChars: 2,
            };
          },
        },
      );

      const call = async () => {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        });
        return executor({ prompt: "x", config: {} });
      };

      const runs = [call(), call(), call()];
      // Give all three time to arrive; only two may be inside runBrowser.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(active).toBe(2);
      expect(peakActive).toBe(2);

      while (finish.length > 0) {
        finish.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const results = await Promise.all(runs);
      expect(results.map((r) => r.answerText)).toEqual(["ok", "ok", "ok"]);
      expect(peakActive).toBe(2);

      await server.close();
    },
  );
});

describe("per-run isolation on the shared host", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "two callers sending the same session slug get distinct server-side sessions",
    async () => {
      // Session slugs are prompt-derived, so collisions are ordinary rather than
      // adversarial — and a shared slug means a shared artifact directory.
      const seen: string[] = [];
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, maxConcurrentRuns: 2 },
        {
          runBrowser: async (options) => {
            seen.push(String(options.sessionId));
            return {
              answerText: "ok",
              answerMarkdown: "ok",
              tookMs: 1,
              answerTokens: 1,
              answerChars: 2,
            };
          },
        },
      );
      const call = async () =>
        createRemoteBrowserExecutor({ host: `127.0.0.1:${server.port}`, token: "secret" })({
          prompt: "x",
          config: {},
          sessionId: "review-the-ts-data",
        });
      await Promise.all([call(), call()]);

      expect(seen).toHaveLength(2);
      expect(seen[0]).not.toEqual(seen[1]);
      for (const sessionId of seen) {
        expect(sessionId.startsWith("review-the-ts-data-")).toBe(true);
      }
      await server.close();
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "the browser tab cap is pinned to what the service admits",
    async () => {
      let observedCap: number | undefined;
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, maxConcurrentRuns: 4 },
        {
          runBrowser: async (options) => {
            observedCap = options.config?.maxConcurrentTabs;
            return {
              answerText: "ok",
              answerMarkdown: "ok",
              tookMs: 1,
              answerTokens: 1,
              answerChars: 2,
            };
          },
        },
      );
      await createRemoteBrowserExecutor({ host: `127.0.0.1:${server.port}`, token: "secret" })({
        prompt: "x",
        // A client asking for a different cap does not get one: this is a
        // property of the host's shared profile, not of the caller's run.
        config: { maxConcurrentTabs: 99 } as never,
      });
      expect(observedCap).toBe(4);
      await server.close();
    },
  );
});

describe("cancellation reaches the run", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a client that disconnects mid-run aborts it instead of letting it finish",
    async () => {
      // Releasing the slot when the run happens to end is not cancellation. The
      // browser keeps a tab and a shared-profile slot for the whole run, so a
      // caller that walked away must be able to give both back immediately.
      let sawSignal: AbortSignal | undefined;
      let observedAbort = false;
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async (options) => {
            sawSignal = options.signal;
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener("abort", () => {
                observedAbort = true;
                resolve();
              });
              // Long enough that natural completion cannot be mistaken for
              // cancellation.
              setTimeout(resolve, 10_000);
            });
            return {
              answerText: "",
              answerMarkdown: "",
              tookMs: 0,
              answerTokens: 0,
              answerChars: 0,
            };
          },
        },
      );

      const request = http.request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/runs",
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        },
        () => {},
      );
      request.write(JSON.stringify({ prompt: "x", options: {}, browserConfig: {} }));
      request.end();

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(sawSignal).toBeDefined();
      expect(observedAbort).toBe(false);

      request.destroy();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(observedAbort).toBe(true);

      await server.close();
    },
  );
});
