import { describe, expect, test } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { createRemoteServer, RunSlots, pickClientBrowserConfig } from "../../src/remote/server.js";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import type { BrowserRunResult } from "../../src/browserMode.js";
import type { RemoteArtifactDescriptor } from "../../src/remote/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { runBrowserMode, runSubmissionWithRecoveryForTest } from "../../src/browser/index.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

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
  test.skipIf(!CAN_LISTEN_LOCALHOST).each([true, false])(
    "enforces the host endpoint and wait over client injection (attachRunning=%s)",
    async (attachRunning) => {
      const hostRoute = {
        attachRunning,
        remoteChrome: { host: "127.0.0.1", port: 9333 },
        approvalWaitMs: 300_000,
      };
      let observed = false;
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "test-host-routing",
          logger: () => {},
          browserConfig: hostRoute,
          manualLoginDefault: true,
          cookieSyncDefault: true,
        },
        {
          runBrowser: async (options) => {
            observed = true;
            expect(options.config).toMatchObject({
              ...hostRoute,
              cookieSync: false,
              thinkingTime: "pro",
            });
            expect(options.config?.manualLogin).not.toBe(true);
            expect(options.config?.chromePath).toBeUndefined();
            expect(options.closeOwnedTabOnComplete).toBe(false);
            return {
              answerText: "host-route",
              answerMarkdown: "host-route",
              tookMs: 1,
              answerTokens: 1,
              answerChars: 10,
            };
          },
        },
      );
      try {
        const execute = createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "test-host-routing",
        });
        const result = await execute({
          prompt: "host route",
          config: {
            attachRunning: !attachRunning,
            remoteChrome: { host: "untrusted.invalid", port: 1 },
            approvalWaitMs: 1,
            manualLogin: true,
            chromePath: "/untrusted",
            cookieSync: true,
            thinkingTime: "pro",
          },
        });
        expect(result.answerText).toBe("host-route");
        expect(observed).toBe(true);
      } finally {
        await server.close();
      }
    },
  );

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
            expect(options.sessionId).toMatch(/^remote-session-id-[0-9a-f-]{36}$/);
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
    "does not materialize a pending fallback bundle before the primary remote submit",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-lazy-fallback-"));
      const fallbackPath = path.join(tmpDir, "fallback.txt");
      await writeFile(fallbackPath, "lazy fallback", "utf8");
      const prepare = async () => {
        throw new Error("client prepare must not run for remote fallback");
      };

      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async (options) => {
            expect(options.fallbackSubmission?.prompt).toBe("fallback prompt");
            expect(options.fallbackSubmission?.attachments).toHaveLength(1);
            const stored = await readFile(options.fallbackSubmission!.attachments[0]!.path, "utf8");
            expect(stored).toBe("lazy fallback");
            expect(options.fallbackSubmission?.prepare).toEqual(expect.any(Function));
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

      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        });
        const result = await executor({
          prompt: "remote",
          fallbackSubmission: {
            prompt: "fallback prompt",
            attachments: [{ path: fallbackPath, displayPath: "fallback.txt", sizeBytes: 13 }],
            prepare,
            pendingBundle: { format: "text", scope: "text-only" },
          },
          config: {},
        });
        expect(result.answerText).toBe("ok");
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "stages colliding primary attachment names without losing payloads",
    async () => {
      await expectRemoteAttachmentStaging({
        location: "primary",
        files: [
          { fileName: "a b.txt", content: "primary with space", stagedName: "a_b.txt" },
          { fileName: "a_b.txt", content: "primary with underscore", stagedName: "a_b-2.txt" },
        ],
      });
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "stages colliding fallback attachment names without losing payloads",
    async () => {
      await expectRemoteAttachmentStaging({
        location: "fallback",
        files: [
          { fileName: "a b.txt", content: "fallback with space", stagedName: "a_b.txt" },
          { fileName: "a_b.txt", content: "fallback with underscore", stagedName: "a_b-2.txt" },
        ],
      });
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "preserves ordinary non-colliding attachment names and payload order",
    async () => {
      await expectRemoteAttachmentStaging({
        location: "primary",
        files: [
          { fileName: "alpha.txt", content: "first", stagedName: "alpha.txt" },
          { fileName: "beta.md", content: "second", stagedName: "beta.md" },
        ],
      });
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST).each(["primary", "fallback"] as const)(
    "reserves supplied suffixes and case-folded basenames in %s staging",
    async (location) => {
      await expectRemoteAttachmentStaging({
        location,
        files: [
          { fileName: "a b.txt", content: "space", stagedName: "a_b.txt" },
          { fileName: "a_b.txt", content: "underscore", stagedName: "a_b-3.txt" },
          { fileName: "a_b-2.txt", content: "reserved suffix", stagedName: "a_b-2.txt" },
          { fileName: "A_B.TXT", content: "uppercase", stagedName: "A_B-4.TXT" },
        ],
      });
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

async function expectRemoteAttachmentStaging({
  location,
  files,
}: {
  location: "primary" | "fallback";
  files: Array<{ fileName: string; content: string; stagedName: string }>;
}): Promise<void> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-staging-test-"));
  const sourceAttachments = [];
  for (const [index, file] of files.entries()) {
    const sourceDir = path.join(tmpDir, String(index));
    await mkdir(sourceDir);
    const sourcePath = path.join(sourceDir, file.fileName);
    await writeFile(sourcePath, file.content, "utf8");
    sourceAttachments.push({
      path: sourcePath,
      displayPath: file.fileName,
      sizeBytes: Buffer.byteLength(file.content),
    });
  }

  const server = await createRemoteServer(
    { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
    {
      runBrowser: async (options) => {
        const stagedAttachments =
          location === "primary" ? options.attachments : options.fallbackSubmission?.attachments;
        expect(stagedAttachments).toHaveLength(files.length);
        if (!stagedAttachments) {
          throw new Error(`missing ${location} attachments`);
        }

        const stagedPaths = stagedAttachments.map((attachment) => attachment.path);
        expect(new Set(stagedPaths).size).toBe(files.length);
        expect(stagedAttachments.map((attachment) => path.basename(attachment.path))).toEqual(
          files.map((file) => file.stagedName),
        );
        expect(stagedAttachments.map((attachment) => attachment.displayPath)).toEqual(
          files.map((file) => file.fileName),
        );
        await expect(
          Promise.all(stagedPaths.map((stagedPath) => readFile(stagedPath, "utf8"))),
        ).resolves.toEqual(files.map((file) => file.content));

        if (location === "primary") {
          // Reach the real browser guard, then stop at a later config check before Chrome starts.
          await expect(
            runBrowserMode({
              prompt: options.prompt,
              attachments: stagedAttachments,
              config: {
                copyProfileSource: "/unused-test-profile",
                remoteChrome: { host: "127.0.0.1", port: 1 },
              },
            }),
          ).rejects.toMatchObject({ details: { stage: "profile-config" } });
        } else {
          let submissions = 0;
          let prepared = false;
          await runSubmissionWithRecoveryForTest({
            prompt: options.prompt,
            attachments: [],
            fallbackSubmission: options.fallbackSubmission,
            submit: async (_prompt, uploaded) => {
              if (submissions++ === 0) {
                throw new BrowserAutomationError("prompt too large", { code: "prompt-too-large" });
              }
              expect(uploaded).toEqual(stagedAttachments);
              return { baselineTurns: null, baselineAssistantText: null };
            },
            prepareFallbackSubmission: async () => {
              prepared = true;
            },
            reloadPromptComposer: async () => {},
            logger: () => {},
          });
          expect(submissions).toBe(2);
          expect(prepared).toBe(true);
        }

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
      prompt: "remote attachment staging",
      attachments: location === "primary" ? sourceAttachments : [],
      fallbackSubmission:
        location === "fallback"
          ? { prompt: "fallback attachment staging", attachments: sourceAttachments }
          : undefined,
      config: {},
    });
    expect(result.answerText).toBe("done");
  } finally {
    await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

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

  test.skipIf(!CAN_LISTEN_LOCALHOST)("does not overwrite the shared-profile tab cap", async () => {
    // The tab cap is the physical constraint on a shared profile and belongs to
    // the host. An operator who lowered it — to stay under an account's
    // throttling, say — must not have that silently replaced by whatever the
    // service happens to admit.
    let observedCap: number | undefined = 7;
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
      config: {},
    });
    // Preserve the host cap, rather than pinning it to the requested service concurrency.
    expect(observedCap).toBe(3);
    await server.close();
  });
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
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, maxConcurrentRuns: 1 },
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
      request.on("error", (error: NodeJS.ErrnoException) => {
        expect(error.code).toBe("ECONNRESET");
      });
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

describe("cancellation across the bridge", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a caller aborting a remote run cancels it on the far side",
    async () => {
      // `signal` has to mean the same thing on both sides. Observed only locally
      // it would look like cancellation while the remote run kept its slot and
      // its browser tab until it finished on its own.
      let observedAbort = false;
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async (options) => {
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener("abort", () => {
                observedAbort = true;
                resolve();
              });
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
      const controller = new AbortController();
      const executor = createRemoteBrowserExecutor({
        host: `127.0.0.1:${server.port}`,
        token: "secret",
      });
      const run = executor({ prompt: "x", config: {}, signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(observedAbort).toBe(false);

      controller.abort();
      await expect(run).rejects.toThrow(/cancelled/i);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(observedAbort).toBe(true);

      await server.close();
    },
  );

  test("an already-aborted caller never sends the request", async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = createRemoteBrowserExecutor({ host: "127.0.0.1:1", token: "secret" });
    await expect(executor({ prompt: "x", config: {}, signal: controller.signal })).rejects.toThrow(
      /cancelled before the request was sent/,
    );
  });
});

describe("bridged result sanitization", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "carries selection evidence and conversation identity, never host detail",
    async () => {
      // Two properties in one test because they are the same decision seen from
      // both sides: the whitelist must pass what makes a remote answer
      // attributable, and must still refuse anything describing this machine.
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async () => {
            const result: BrowserRunResult = {
              answerText: "hi",
              answerMarkdown: "hi",
              tookMs: 1,
              answerTokens: 1,
              answerChars: 2,
              modelSelection: {
                requestedModel: "gpt-5.6-sol",
                resolvedLabel: "GPT-5.6 Sol",
                strategy: "select",
                status: "switched",
                verified: true,
                source: "chatgpt-model-picker",
                capturedAt: "2026-08-18T00:00:00.000Z",
              },
              thinkingSelection: {
                requestedLevel: "pro",
                status: "switched",
                resolvedLabel: "Pro",
                verified: true,
                strictFailClosed: true,
                source: "chatgpt-thinking-picker",
                capturedAt: "2026-08-18T00:00:00.000Z",
              },
              tabUrl: "https://chatgpt.com/c/abc-123",
              researchPlan: {
                title: "Compare public release schedules",
                steps: ["Read official sources", "Compare support dates"],
                phase: "researching",
                capturedAt: "2026-09-08T00:00:00.000Z",
              },
              conversationId: "abc-123",
              promptSubmitted: true,
              chromePid: 4242,
              chromePort: 9222,
              userDataDir: "/Users/someone/.oracle/browser-profile",
            };
            return result;
          },
        },
      );

      const executor = createRemoteBrowserExecutor({
        host: `127.0.0.1:${server.port}`,
        token: "secret",
      });
      const result = await executor({ prompt: "remote", config: {} });

      // Without these a bridged run cannot be proven to have answered at the
      // requested model and effort, and its answer cannot be bound to a URL.
      expect(result.thinkingSelection).toMatchObject({
        requestedLevel: "pro",
        verified: true,
        strictFailClosed: true,
      });
      expect(result.modelSelection?.resolvedLabel).toBe("GPT-5.6 Sol");
      expect(result.researchPlan).toMatchObject({
        title: "Compare public release schedules",
        steps: ["Read official sources", "Compare support dates"],
        phase: "researching",
      });
      expect(result.conversationId).toBe("abc-123");
      expect(result.tabUrl).toBe("https://chatgpt.com/c/abc-123");

      // Host detail stays on the host.
      expect(result.chromePid).toBeUndefined();
      expect(result.chromePort).toBeUndefined();
      expect(result.userDataDir).toBeUndefined();

      await server.close();
    },
  );
});

describe("client browser-config allowlist", () => {
  test("passes through the fields that describe the conversation", () => {
    const accepted = pickClientBrowserConfig({
      chatgptUrl: "https://chatgpt.com/g/g-p-abc/project",
      desiredModel: "gpt-5.6-sol",
      modelStrategy: "select",
      thinkingTime: "pro",
      archiveConversations: "never",
      resumeConversationUrl: "https://chatgpt.com/c/abc-123",
      timeoutMs: 900_000,
    });
    expect(accepted).toEqual({
      chatgptUrl: "https://chatgpt.com/g/g-p-abc/project",
      desiredModel: "gpt-5.6-sol",
      modelStrategy: "select",
      thinkingTime: "pro",
      archiveConversations: "never",
      resumeConversationUrl: "https://chatgpt.com/c/abc-123",
      timeoutMs: 900_000,
    });
  });

  test("drops every field that describes the host rather than the conversation", () => {
    // Each of these is a different way for a token holder to stop asking
    // questions and start running code, reading credentials, or steering another
    // caller's tab. Named individually so a regression names its own hazard.
    const accepted = pickClientBrowserConfig({
      chromePath: "/tmp/evil",
      chromeProfile: "/Users/someone/Library/Application Support/Google/Chrome",
      chromeCookiePath: "/Users/someone/Library/Cookies",
      copyProfileSource: "/Users/someone/Library/Application Support/Google/Chrome",
      remoteChrome: { host: "attacker.example", port: 9222 },
      debugPort: 9222,
      attachRunning: true,
      browserTabRef: "current",
      headless: true,
      hideWindow: true,
      manualLogin: false,
      manualLoginProfileDir: "/tmp/profile",
      manualLoginCookieSync: true,
      cookieSync: true,
      cookieNames: ["__Secure-next-auth.session-token"],
      inlineCookies: [],
      inlineCookiesSource: "somewhere",
      allowCookieErrors: true,
      maxConcurrentTabs: 99,
      profileLockTimeoutMs: 0,
      reuseChromeWaitMs: 0,
      desiredModel: "gpt-5.6-sol",
    } as never);
    expect(accepted).toEqual({ desiredModel: "gpt-5.6-sol" });
  });

  test("treats a missing config as an empty one", () => {
    expect(pickClientBrowserConfig(undefined)).toEqual({});
    expect(pickClientBrowserConfig(null)).toEqual({});
  });
});

describe("advertised addresses", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)("a loopback bind advertises only loopback", async () => {
    // The banner is how an operator decides whether this port needs a tunnel or
    // a firewall rule. Listing LAN and tailnet addresses for a service bound to
    // 127.0.0.1 tells them it is exposed when it is not.
    const lines: string[] = [];
    const server = await createRemoteServer(
      {
        host: "127.0.0.1",
        port: 0,
        token: "secret",
        logger: (message: string) => lines.push(message),
      },
      {
        runBrowser: async () => ({
          answerText: "",
          answerMarkdown: "",
          tookMs: 0,
          answerTokens: 0,
          answerChars: 0,
        }),
      },
    );
    const banner = lines.join("\n");
    expect(banner).toContain("127.0.0.1");
    expect(banner).not.toMatch(/\b10\.\d+\.\d+\.\d+\b/);
    expect(banner).not.toMatch(/\b100\.\d+\.\d+\.\d+\b/);
    expect(banner).not.toMatch(/\b192\.168\.\d+\.\d+\b/);
    await server.close();
  });
});
