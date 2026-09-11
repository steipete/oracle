import http from "node:http";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import type { BrowserRunOptions } from "../browserMode.js";
import type { BrowserRunResult } from "../browserMode.js";
import type { BrowserAttachment, SavedBrowserFile, SavedBrowserImage } from "../browser/types.js";
import {
  appendArtifacts,
  computeFileSha256,
  resolveSessionArtifactsDir,
  resolveUniqueArtifactPath,
  sanitizeArtifactFilename,
  sanitizeArtifactMimeType,
  validateArtifactFile,
} from "../browser/artifacts.js";
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  type RemoteArtifactDescriptor,
  type RemoteRunPayload,
  type RemoteRunEvent,
  type RemoteAttachmentPayload,
} from "./types.js";
import { materializeStagedFallbackBundle } from "../browser/prompt.js";
import { checkRemoteHealth } from "./health.js";
import { parseHostPort } from "../bridge/connection.js";
import { BrowserRunCancelledError } from "../oracle/errors.js";
import { resolveSiblingImagePath } from "../browser/chatgptImages.js";

interface RemoteExecutorOptions {
  host: string;
  token?: string;
}

type TransferredBrowserArtifact = SavedBrowserFile | SavedBrowserImage;

export function createRemoteBrowserExecutor({ host, token }: RemoteExecutorOptions) {
  // Return a drop-in replacement for runBrowserMode so the browser session runner can stay unchanged.
  return async function remoteBrowserExecutor(
    options: BrowserRunOptions,
  ): Promise<BrowserRunResult> {
    if (options.config?.researchMode === "search") {
      throw new Error(
        "Web Search is a local browser pilot; --remote-host does not negotiate this capability yet. Use local Chrome or --browser-attach-running.",
      );
    }
    const callerSignal = options.signal;
    if (callerSignal?.aborted)
      throw new BrowserRunCancelledError("Browser run cancelled before the request was sent.");
    if (callerSignal) {
      const health = await checkRemoteHealth({ host, token, signal: callerSignal });
      if (callerSignal.aborted) throw new BrowserRunCancelledError();
      if (health.capabilities?.runCancellation !== true)
        throw new Error(
          "Remote host does not support run cancellation; upgrade the host before using an AbortSignal.",
        );
    }
    const payload: RemoteRunPayload = {
      prompt: options.prompt,
      attachments: await serializeAttachments(options.attachments ?? []),
      fallbackSubmission: await serializeFallback(options.fallbackSubmission, { host, token }),
      browserConfig: options.config ?? {},
      options: {
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        verbose: options.verbose,
        sessionId: options.sessionId,
        followUpPrompts: options.followUpPrompts,
        cancelOnDisconnect: callerSignal ? true : undefined,
        imageOutputRequested: Boolean(options.generateImagePath || options.outputPath),
      },
    };

    const body = Buffer.from(JSON.stringify(payload));
    const { hostname, port } = parseHost(host);

    return new Promise<BrowserRunResult>((resolve, reject) => {
      if (callerSignal?.aborted) {
        reject(new Error("Browser run cancelled before the request was sent."));
        return;
      }
      const transferredArtifacts: TransferredBrowserArtifact[] = [];
      const transferFailures: string[] = [];
      const transferPromises: Promise<void>[] = [];
      let artifactTransferQueue = Promise.resolve();
      const preferredImagePath = options.generateImagePath ?? options.outputPath;
      let preferredImageIndex = 0;
      let settled = false;
      let resolved: BrowserRunResult | null = null;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        callerSignal?.removeEventListener("abort", onCallerAbort);
        reject(error);
      };

      const req = http.request(
        {
          hostname,
          port,
          path: "/runs",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": body.length,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            collectError(res)
              .then((message) => fail(new Error(message)))
              .catch(fail);
            return;
          }
          res.setEncoding("utf8");
          let buffer = "";
          res.on("data", (chunk: string) => {
            buffer += chunk;
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex !== -1) {
              const line = buffer.slice(0, newlineIndex).trim();
              buffer = buffer.slice(newlineIndex + 1);
              if (line.length > 0) {
                const transferPromise = handleEvent({
                  line,
                  options,
                  hostname,
                  port,
                  token,
                  onResult: (result) => {
                    resolved = result;
                  },
                  onArtifact: (artifact) => {
                    transferredArtifacts.push(artifact);
                  },
                  onArtifactFailure: (message) => {
                    transferFailures.push(message);
                  },
                  enqueueArtifactTransfer: (transfer) => {
                    const queued = artifactTransferQueue.then(transfer);
                    artifactTransferQueue = queued.catch(() => undefined);
                    return queued;
                  },
                  resolvePreferredImagePath: (descriptor) => {
                    if (!preferredImagePath) return undefined;
                    const extension = path.extname(descriptor.filename).slice(1) || "png";
                    return resolveSiblingImagePath(
                      path.resolve(preferredImagePath),
                      preferredImageIndex++,
                      extension,
                    );
                  },
                  onError: fail,
                });
                if (transferPromise) {
                  transferPromises.push(transferPromise);
                }
              }
              newlineIndex = buffer.indexOf("\n");
            }
          });
          res.on("end", () => {
            void (async () => {
              await Promise.allSettled(transferPromises);
              if (settled) return;
              if (!resolved) {
                fail(new Error("Remote browser run completed without a result."));
                return;
              }
              settled = true;
              callerSignal?.removeEventListener("abort", onCallerAbort);
              resolve(mergeTransferredArtifacts(resolved, transferredArtifacts, transferFailures));
            })().catch(fail);
          });
          res.on("error", fail);
        },
      );
      req.on("error", fail);

      // Destroying the request closes the socket, which is how the service learns
      // to abort: its own disconnect handler fires and releases the slot and the
      // browser tab.
      const onCallerAbort = () => {
        req.destroy();
        fail(new BrowserRunCancelledError("Browser run cancelled: the caller aborted."));
      };
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

      req.write(body);
      req.end();
    });
  };
}

async function serializeFallback(
  fallback: BrowserRunOptions["fallbackSubmission"],
  remote: RemoteExecutorOptions,
): Promise<RemoteRunPayload["fallbackSubmission"]> {
  if (!fallback) return undefined;
  if (fallback.pendingBundle) {
    const health = await checkRemoteHealth(remote);
    if (!health.ok || health.capabilities?.deferredFallbackBundling !== true) {
      // Older hosts ignore bundle metadata, so send a ready-to-upload fallback.
      const prepared = await materializeStagedFallbackBundle({
        composerText: fallback.prompt,
        attachments: fallback.attachments,
        ...fallback.pendingBundle,
      });
      try {
        return {
          prompt: prepared.composerText,
          attachments: await serializeAttachments(prepared.attachments),
        };
      } finally {
        await rm(path.dirname(prepared.bundled.bundlePath), { recursive: true, force: true });
      }
    }
  }
  return {
    prompt: fallback.prompt,
    attachments: await serializeAttachments(fallback.attachments),
    bundle: fallback.pendingBundle,
  };
}

async function serializeAttachments(
  attachments: BrowserAttachment[],
): Promise<RemoteAttachmentPayload[]> {
  const serialized: RemoteAttachmentPayload[] = [];
  for (const attachment of attachments) {
    // Read the local file upfront so the remote host never touches the caller's filesystem.
    const content = await readFile(attachment.path);
    serialized.push({
      fileName: path.basename(attachment.path),
      displayPath: attachment.displayPath,
      sizeBytes: attachment.sizeBytes,
      contentBase64: content.toString("base64"),
    });
  }
  return serialized;
}

function parseHost(input: string): { hostname: string; port: number } {
  try {
    return parseHostPort(input);
  } catch (error) {
    throw new Error(
      `Invalid remote host: ${input} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function handleEvent(params: {
  line: string;
  options: BrowserRunOptions;
  hostname: string;
  port: number;
  token?: string;
  onResult: (result: BrowserRunResult) => void;
  onArtifact: (artifact: TransferredBrowserArtifact) => void;
  onArtifactFailure: (message: string) => void;
  enqueueArtifactTransfer: (transfer: () => Promise<void>) => Promise<void>;
  resolvePreferredImagePath: (descriptor: RemoteArtifactDescriptor) => string | undefined;
  onError: (error: Error) => void;
}): Promise<void> | null {
  let event: RemoteRunEvent;
  try {
    event = JSON.parse(params.line) as RemoteRunEvent;
  } catch (error) {
    params.onError(
      new Error(
        `Failed to parse remote event: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return null;
  }
  if (event.type === "log") {
    params.options.log?.(event.message);
    return null;
  }
  if (event.type === "error") {
    params.onError(new Error(event.message));
    return null;
  }
  if (event.type === "artifact-progress") {
    if (params.options.verbose) {
      params.options.log?.(
        `[browser] Artifact ${event.artifactId} ${event.phase}${
          event.receivedBytes !== undefined && event.totalBytes !== undefined
            ? ` ${event.receivedBytes}/${event.totalBytes} bytes`
            : ""
        }`,
      );
    }
    return null;
  }
  if (event.type === "artifact-ready") {
    const displayFilename = sanitizeArtifactFilename(
      String(event.artifact?.filename ?? ""),
      "artifact.bin",
    );
    const preferredPath =
      event.artifact.kind === "image"
        ? params.resolvePreferredImagePath(event.artifact)
        : undefined;
    const transfer = params.enqueueArtifactTransfer(() =>
      transferRemoteArtifact({
        hostname: params.hostname,
        port: params.port,
        token: params.token,
        descriptor: event.artifact,
        sessionId: params.options.sessionId,
        preferredPath,
        signal: params.options.signal,
        log: params.options.log,
      })
        .then((artifact) => {
          params.onArtifact(artifact);
        })
        .catch((error) => {
          if (params.options.signal?.aborted) {
            params.onError(new BrowserRunCancelledError());
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          const fallback = `Oracle captured the browser text response, but bridge artifact transfer failed for ${displayFilename}. Open the ChatGPT browser on the bridge host, download the ZIP/file shown in the current response, and copy it to a cloud-readable path. Reason: ${message}`;
          params.options.log?.(`[browser] ${fallback}`);
          params.onArtifactFailure(fallback);
        }),
    );
    return transfer;
  }
  if (event.type === "result") {
    params.onResult(event.result);
  }
  return null;
}

async function transferRemoteArtifact(params: {
  hostname: string;
  port: number;
  token?: string;
  descriptor: RemoteArtifactDescriptor;
  sessionId?: string;
  preferredPath?: string;
  log?: BrowserRunOptions["log"];
  signal?: AbortSignal;
}): Promise<TransferredBrowserArtifact> {
  params.signal?.throwIfAborted();
  validateRemoteArtifactDescriptor(params.descriptor);
  const sessionId = params.sessionId ?? params.descriptor.runId;
  const artifactsDir = resolveSessionArtifactsDir(sessionId);
  const filename = sanitizeArtifactFilename(
    params.descriptor.filename,
    `artifact-${params.descriptor.artifactId}.bin`,
  );
  const finalPath = params.preferredPath
    ? path.resolve(params.preferredPath)
    : await resolveUniqueArtifactPath(path.join(artifactsDir, filename));
  await mkdir(path.dirname(finalPath), { recursive: true });
  const partPath = `${finalPath}.part-${params.descriptor.artifactId}`;
  const artifactPath = `/runs/${encodeURIComponent(params.descriptor.runId)}/artifacts/${encodeURIComponent(
    params.descriptor.artifactId,
  )}`;

  params.log?.(`[browser] Transferring artifact ${filename} from bridge host...`);
  await downloadArtifactToFile({
    hostname: params.hostname,
    port: params.port,
    path: artifactPath,
    token: params.token,
    targetPath: partPath,
    descriptor: params.descriptor,
    signal: params.signal,
  }).catch(async (error) => {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw error;
  });

  const fileStat = await stat(partPath);
  if (fileStat.size !== params.descriptor.byteSize) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error(`size mismatch (${fileStat.size} != ${params.descriptor.byteSize})`);
  }
  const sha256 = await computeFileSha256(partPath);
  if (sha256 !== params.descriptor.sha256) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error("sha256 mismatch");
  }
  const validation = await validateArtifactFile({
    path: partPath,
    filename,
    mimeType: sanitizeArtifactMimeType(params.descriptor.mimeType),
  });
  if (!validation.ok) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error(`${validation.type} validation failed: ${validation.error ?? "invalid"}`);
  }

  if (params.signal?.aborted) {
    await rm(partPath, { force: true });
    throw new BrowserRunCancelledError();
  }
  await rename(partPath, finalPath);
  params.log?.(`[browser] Transferred artifact to ${finalPath}`);
  const publishedFilename = path.basename(finalPath);
  const baseArtifact = {
    path: finalPath,
    label: publishedFilename,
    mimeType: sanitizeArtifactMimeType(params.descriptor.mimeType),
    sizeBytes: fileStat.size,
    sourceUrl: "bridge-artifact",
    sha256,
    validation,
    transfer: { status: "completed", bytes: fileStat.size },
    origin: { mode: "bridge" },
    url: "bridge-artifact",
    finalUrl: "bridge-artifact",
  } as const;
  if (params.descriptor.kind === "image") {
    return {
      ...baseArtifact,
      kind: "image",
    };
  }
  return {
    ...baseArtifact,
    kind: "file",
    filename: publishedFilename,
  };
}

async function downloadArtifactToFile(params: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  targetPath: string;
  descriptor: RemoteArtifactDescriptor;
  signal?: AbortSignal;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        hostname: params.hostname,
        port: params.port,
        path: params.path,
        method: "GET",
        signal: params.signal,
        headers: params.token ? { authorization: `Bearer ${params.token}` } : undefined,
      },
      (res) => {
        if (res.statusCode !== 200) {
          collectError(res)
            .then((message) => reject(new Error(message)))
            .catch(reject);
          return;
        }
        const headerSha = String(res.headers["x-oracle-artifact-sha256"] ?? "");
        if (headerSha && headerSha !== params.descriptor.sha256) {
          res.resume();
          reject(new Error("artifact sha256 header mismatch"));
          return;
        }
        const contentLengthHeader = res.headers["content-length"];
        const contentLength =
          typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : undefined;
        if (
          contentLength !== undefined &&
          (!Number.isSafeInteger(contentLength) ||
            contentLength <= 0 ||
            contentLength > MAX_REMOTE_ARTIFACT_BYTES ||
            contentLength !== params.descriptor.byteSize)
        ) {
          res.resume();
          reject(new Error("artifact content-length mismatch"));
          return;
        }
        const output = createWriteStream(params.targetPath, { flags: "wx" });
        let receivedBytes = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            receivedBytes += chunk.length;
            if (
              receivedBytes > params.descriptor.byteSize ||
              receivedBytes > MAX_REMOTE_ARTIFACT_BYTES
            ) {
              callback(new Error("artifact exceeded declared size"));
              return;
            }
            callback(null, chunk);
          },
        });
        void pipeline(res, limiter, output).then(() => resolve(), reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function validateRemoteArtifactDescriptor(descriptor: RemoteArtifactDescriptor): void {
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    (descriptor.kind !== "file" && descriptor.kind !== "image") ||
    typeof descriptor.runId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(descriptor.runId) ||
    typeof descriptor.artifactId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(descriptor.artifactId) ||
    typeof descriptor.filename !== "string" ||
    !Number.isSafeInteger(descriptor.byteSize) ||
    descriptor.byteSize <= 0 ||
    descriptor.byteSize > MAX_REMOTE_ARTIFACT_BYTES ||
    typeof descriptor.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(descriptor.sha256)
  ) {
    throw new Error("invalid bridge artifact descriptor");
  }
}

function mergeTransferredArtifacts(
  result: BrowserRunResult,
  transferredArtifacts: TransferredBrowserArtifact[],
  transferFailures: string[],
): BrowserRunResult {
  const transferredFiles = transferredArtifacts.filter(
    (artifact): artifact is SavedBrowserFile => artifact.kind === "file",
  );
  const transferredImages = transferredArtifacts.filter(
    (artifact): artifact is SavedBrowserImage => artifact.kind === "image",
  );
  const artifacts = appendArtifacts(result.artifacts, transferredArtifacts);
  const savedFiles = appendSavedFiles(result.savedFiles, transferredFiles);
  const savedImages = appendSavedImages(result.savedImages, transferredImages);
  const warnings = [
    ...(result.warnings ?? []),
    ...transferFailures.map((message) => ({
      code: "remote-artifact-transfer-failed",
      severity: "warning" as const,
      message,
    })),
  ];
  return {
    ...result,
    artifacts,
    savedFiles,
    savedImages,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function appendSavedImages(
  existing: SavedBrowserImage[] | undefined,
  additions: SavedBrowserImage[],
): SavedBrowserImage[] | undefined {
  const merged = new Map<string, SavedBrowserImage>();
  for (const artifact of existing ?? []) {
    merged.set(artifact.path, artifact);
  }
  for (const artifact of additions) {
    merged.set(artifact.path, artifact);
  }
  const values = Array.from(merged.values());
  return values.length > 0 ? values : undefined;
}

function appendSavedFiles(
  existing: SavedBrowserFile[] | undefined,
  additions: SavedBrowserFile[],
): SavedBrowserFile[] | undefined {
  const merged = new Map<string, SavedBrowserFile>();
  for (const artifact of existing ?? []) {
    merged.set(artifact.path, artifact);
  }
  for (const artifact of additions) {
    merged.set(artifact.path, artifact);
  }
  const values = Array.from(merged.values());
  return values.length > 0 ? values : undefined;
}

function collectError(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    res.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed.error ?? `Remote host responded with status ${res.statusCode}`);
      } catch {
        resolve(raw || `Remote host responded with status ${res.statusCode}`);
      }
    });
    res.on("error", reject);
  });
}
