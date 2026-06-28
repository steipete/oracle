import type { BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserRunResult } from "../browserMode.js";
import type { BrowserAttachment } from "../browser/types.js";
import type { SessionArtifactValidation } from "../sessionManager.js";

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
  };
  browserConfig: BrowserSessionConfig;
  options: {
    heartbeatIntervalMs?: number;
    verbose?: boolean;
    sessionId?: string;
    followUpPrompts?: string[];
  };
}

export interface RemoteArtifactCapabilities {
  artifactTransfer: boolean;
  artifactProtocolVersion: number;
  maxArtifactBytes: number;
}

export interface RemoteArtifactDescriptor {
  artifactId: string;
  runId: string;
  kind: "file";
  filename: string;
  label?: string;
  mimeType?: string;
  byteSize: number;
  sha256: string;
  validation?: SessionArtifactValidation;
  sourceUrlKind: "sandbox" | "chatgpt-file-endpoint" | "browser-download";
  transferStatus: "ready" | "streaming" | "completed" | "failed" | "skipped";
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
