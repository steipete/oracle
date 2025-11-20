import type { BrowserSessionConfig } from '../sessionStore.js';
import type { BrowserRunResult } from '../browserMode.js';
import type { BrowserAttachment } from '../browser/types.js';

export interface RemoteAttachmentPayload {
  fileName: string;
  displayPath: string;
  sizeBytes?: number;
  contentBase64: string;
}

export interface RemoteRunPayload {
  prompt: string;
  attachments: RemoteAttachmentPayload[];
  browserConfig: BrowserSessionConfig;
  options: {
    heartbeatIntervalMs?: number;
    verbose?: boolean;
  };
}

export type RemoteRunEvent =
  | { type: 'log'; message: string }
  | { type: 'result'; result: BrowserRunResult }
  | { type: 'error'; message: string };

export interface SerializedAttachment extends BrowserAttachment {
  fileName: string;
  contentBase64: string;
}
