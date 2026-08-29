import { describe, expect, test } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { createRemoteServer, pickClientBrowserConfig } from "../../src/remote/server.js";
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
            expect(options.sessionId).toBe("remote-session-id");
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
