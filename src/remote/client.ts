import http from "node:http";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import type { BrowserRunOptions } from "../browserMode.js";
import type { BrowserRunResult } from "../browserMode.js";
import type { BrowserAttachment, SavedBrowserFile } from "../browser/types.js";
import {
  appendArtifacts,
  computeFileSha256,
  resolveSessionArtifactsDir,
  resolveUniqueArtifactPath,
  sanitizeArtifactFilename,
  validateArtifactFile,
} from "../browser/artifacts.js";
import type {
  RemoteArtifactDescriptor,
  RemoteRunPayload,
  RemoteRunEvent,
  RemoteAttachmentPayload,
} from "./types.js";
import { parseHostPort } from "../bridge/connection.js";

interface RemoteExecutorOptions {
  host: string;
  token?: string;
}

export function createRemoteBrowserExecutor({ host, token }: RemoteExecutorOptions) {
  // Return a drop-in replacement for runBrowserMode so the browser session runner can stay unchanged.
  return async function remoteBrowserExecutor(
    options: BrowserRunOptions,
  ): Promise<BrowserRunResult> {
    const payload: RemoteRunPayload = {
      prompt: options.prompt,
      attachments: await serializeAttachments(options.attachments ?? []),
      fallbackSubmission: options.fallbackSubmission
        ? {
            prompt: options.fallbackSubmission.prompt,
            attachments: await serializeAttachments(options.fallbackSubmission.attachments ?? []),
          }
        : undefined,
      browserConfig: options.config ?? {},
      options: {
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        verbose: options.verbose,
        sessionId: options.sessionId,
        followUpPrompts: options.followUpPrompts,
      },
    };

    const body = Buffer.from(JSON.stringify(payload));
    const { hostname, port } = parseHost(host);

    return new Promise<BrowserRunResult>((resolve, reject) => {
      const transferredFiles: SavedBrowserFile[] = [];
      const transferFailures: string[] = [];
      const transferPromises: Promise<void>[] = [];
      let settled = false;
      let resolved: BrowserRunResult | null = null;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
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
                    transferredFiles.push(artifact);
                  },
                  onArtifactFailure: (message) => {
                    transferFailures.push(message);
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
              resolve(mergeTransferredArtifacts(resolved, transferredFiles, transferFailures));
            })().catch(fail);
          });
          res.on("error", fail);
        },
      );
      req.on("error", fail);
      req.write(body);
      req.end();
    });
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
  onArtifact: (artifact: SavedBrowserFile) => void;
  onArtifactFailure: (message: string) => void;
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
    const transfer = transferRemoteArtifact({
      hostname: params.hostname,
      port: params.port,
      token: params.token,
      descriptor: event.artifact,
      sessionId: params.options.sessionId,
      log: params.options.log,
    })
      .then((artifact) => {
        params.onArtifact(artifact);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const fallback = `Oracle captured the browser text response, but bridge artifact transfer failed for ${event.artifact.filename}. Open the ChatGPT browser on the bridge host, download the ZIP/file shown in the current response, and copy it to a cloud-readable path. Reason: ${message}`;
        params.options.log?.(`[browser] ${fallback}`);
        params.onArtifactFailure(fallback);
      });
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
  log?: BrowserRunOptions["log"];
}): Promise<SavedBrowserFile> {
  const sessionId = params.sessionId ?? params.descriptor.runId;
  const artifactsDir = resolveSessionArtifactsDir(sessionId);
  await mkdir(artifactsDir, { recursive: true });
  const filename = sanitizeArtifactFilename(
    params.descriptor.filename,
    `artifact-${params.descriptor.artifactId}.bin`,
  );
  const finalPath = await resolveUniqueArtifactPath(path.join(artifactsDir, filename));
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
    mimeType: params.descriptor.mimeType,
  });
  if (!validation.ok) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error(`${validation.type} validation failed: ${validation.error ?? "invalid"}`);
  }

  await rename(partPath, finalPath);
  params.log?.(`[browser] Transferred artifact to ${finalPath}`);
  return {
    kind: "file",
    path: finalPath,
    label: params.descriptor.label ?? filename,
    mimeType: params.descriptor.mimeType,
    sizeBytes: fileStat.size,
    sourceUrl: "bridge-artifact",
    sha256,
    validation,
    transfer: { status: "completed", bytes: fileStat.size },
    origin: { mode: "bridge" },
    url: "bridge-artifact",
    finalUrl: "bridge-artifact",
    filename,
  };
}

async function downloadArtifactToFile(params: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  targetPath: string;
  descriptor: RemoteArtifactDescriptor;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        hostname: params.hostname,
        port: params.port,
        path: params.path,
        method: "GET",
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
        const contentLength = Number(res.headers["content-length"] ?? 0);
        if (contentLength && contentLength !== params.descriptor.byteSize) {
          res.resume();
          reject(new Error("artifact content-length mismatch"));
          return;
        }
        const output = createWriteStream(params.targetPath, { flags: "wx" });
        output.on("error", reject);
        res.on("error", reject);
        output.on("finish", () => resolve());
        res.pipe(output);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function mergeTransferredArtifacts(
  result: BrowserRunResult,
  transferredFiles: SavedBrowserFile[],
  transferFailures: string[],
): BrowserRunResult {
  const artifacts = appendArtifacts(result.artifacts, transferredFiles);
  const savedFiles = appendSavedFiles(result.savedFiles, transferredFiles);
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
    warnings: warnings.length > 0 ? warnings : undefined,
  };
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
