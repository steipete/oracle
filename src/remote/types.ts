import type { BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserRunResult } from "../browserMode.js";
import type { BrowserAttachment } from "../browser/types.js";
import type { SessionArtifactValidation } from "../sessionManager.js";

export const MAX_REMOTE_ARTIFACT_BYTES = 512 * 1024 * 1024;

export interface RemoteAttachmentPayload {
  fileName: string;
  displayPath: string;
  sizeBytes?: number;
  contentBase64: string;
}

export interface RemoteRunPayload {
  prompt: string;
  attachments: RemoteAttachmentPayload[];
  fallbackSubmission?: {
    prompt: string;
    attachments: RemoteAttachmentPayload[];
    bundle?: {
      format: "text" | "zip";
      scope: "text-only" | "all";
    };
  };
  browserConfig: BrowserSessionConfig;
  options: {
    heartbeatIntervalMs?: number;
    verbose?: boolean;
    sessionId?: string;
    followUpPrompts?: string[];
    cancelOnDisconnect?: boolean;
    /** Request image-aware waiting and capture without exposing a client filesystem path to the host. */
    imageOutputRequested?: boolean;
  };
}

export interface RemoteArtifactCapabilities {
  artifactTransfer: boolean;
  artifactProtocolVersion: number;
  maxArtifactBytes: number;
  deferredFallbackBundling?: boolean;
  runCancellation?: boolean;
  /** Captures requested images on the host and transfers them with artifact protocol v1. */
  generatedImages?: boolean;
}

export interface RemoteArtifactDescriptor {
  artifactId: string;
  runId: string;
  kind: "file" | "image";
  filename: string;
  mimeType?: string;
  byteSize: number;
  sha256: string;
  validation?: SessionArtifactValidation;
  image?: { width?: number; height?: number; fileId?: string };
  sourceUrlKind: "sandbox" | "chatgpt-file-endpoint" | "browser-download";
  transferStatus: "ready" | "streaming" | "completed" | "failed" | "skipped";
}

export function pickRemoteImageMetadata(
  image: {
    width?: unknown;
    height?: unknown;
    fileId?: unknown;
  } = {},
): NonNullable<RemoteArtifactDescriptor["image"]> {
  return {
    ...(Number.isSafeInteger(image.width) && Number(image.width) > 0
      ? { width: Number(image.width) }
      : {}),
    ...(Number.isSafeInteger(image.height) && Number(image.height) > 0
      ? { height: Number(image.height) }
      : {}),
    ...(typeof image.fileId === "string" && /^file[-_][a-z0-9_-]{1,200}$/i.test(image.fileId)
      ? { fileId: image.fileId }
      : {}),
  };
}

export type RemoteRunEvent =
  | { type: "log"; message: string }
  | { type: "artifact-ready"; runId: string; artifact: RemoteArtifactDescriptor }
  | {
      type: "artifact-progress";
      artifactId: string;
      receivedBytes?: number;
      totalBytes?: number;
      phase: "download" | "transfer" | "validate";
    }
  | { type: "result"; result: BrowserRunResult }
  | { type: "error"; message: string };

export interface SerializedAttachment extends BrowserAttachment {
  fileName: string;
  contentBase64: string;
}
