import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ChromeClient, BrowserAttachment } from "../types.js";
import {
  assertComposerNavigationSnapshot,
  buildFileInputGuardExpression,
} from "./attachmentContext.js";

const MAX_DATA_TRANSFER_BYTES = 20 * 1024 * 1024;

export async function transferAttachmentViaDataTransfer(
  runtime: ChromeClient["Runtime"],
  attachment: BrowserAttachment,
  selector: string,
  navigationUrl?: string,
): Promise<{ fileName: string; size: number }> {
  const fileContent = await readFile(attachment.path);
  if (fileContent.length > MAX_DATA_TRANSFER_BYTES) {
    throw new Error(
      `Attachment ${path.basename(attachment.path)} is too large for data transfer (${fileContent.length} bytes). Maximum size is ${MAX_DATA_TRANSFER_BYTES} bytes.`,
    );
  }

  const base64Content = fileContent.toString("base64");
  const fileName = path.basename(attachment.path);
  const mimeType = guessMimeType(fileName);

  const expression = `(() => {
    if (!('File' in window) || !('Blob' in window) || !('DataTransfer' in window) || typeof atob !== 'function') {
      return { success: false, error: 'Required file APIs are not available in this browser' };
    }

    const fileInput = document.querySelector(${JSON.stringify(selector)});
    if (!fileInput) {
      return { success: false, error: 'File input not found' };
    }
    if (!(fileInput instanceof HTMLInputElement) || fileInput.type !== 'file') {
      return { success: false, error: 'Found element is not a file input' };
    }

    const guard = ${navigationUrl ? buildFileInputGuardExpression("fileInput", navigationUrl) : "null"};
    if (guard?.blocked) { guard.cleanup(); return { success: false, navigationBlocked: guard.blocked }; }
    let syntheticFiles = false;
    const navigationFailure = () => {
      if (syntheticFiles) delete fileInput.files;
      fileInput.value = '';
      return { success: false, navigationBlocked: guard.blocked };
    };
    try {

    const base64Data = ${JSON.stringify(base64Content)};
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: ${JSON.stringify(mimeType)} });

    const file = new File([blob], ${JSON.stringify(fileName)}, {
      type: ${JSON.stringify(mimeType)},
      lastModified: Date.now(),
    });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    let assigned = false;

    const proto = Object.getPrototypeOf(fileInput);
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'files') : null;
    if (descriptor?.set) {
      try {
        descriptor.set.call(fileInput, dataTransfer.files);
        assigned = true;
      } catch {
        assigned = false;
      }
    }
    if (!assigned) {
      try {
        Object.defineProperty(fileInput, 'files', {
          configurable: true,
          get: () => dataTransfer.files,
        });
        syntheticFiles = true;
        assigned = true;
      } catch {
        assigned = false;
      }
    }
    if (!assigned) {
      try {
        fileInput.files = dataTransfer.files;
        assigned = true;
      } catch {
        assigned = false;
      }
    }
    if (!assigned) {
      return { success: false, error: 'Unable to assign FileList to input' };
    }

    if (guard && !guard.validate(true)) return navigationFailure();
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    if (guard && !guard.validate(true)) return navigationFailure();
    return { success: true, fileName: file.name, size: file.size };
    } finally { guard?.cleanup(); }
  })()`;

  const evalResult = await runtime.evaluate({ expression, returnByValue: true });
  if (evalResult.exceptionDetails) {
    const description = evalResult.exceptionDetails.text ?? "JS evaluation failed";
    throw new Error(`Failed to transfer file to browser: ${description}`);
  }

  if (
    !evalResult.result ||
    typeof evalResult.result.value !== "object" ||
    evalResult.result.value == null
  ) {
    throw new Error("Failed to transfer file to browser: unexpected evaluation result");
  }

  const uploadResult = evalResult.result.value as {
    success?: boolean;
    error?: string;
    fileName?: string;
    size?: number;
    navigationBlocked?: unknown;
  };
  if (uploadResult.navigationBlocked && navigationUrl) {
    assertComposerNavigationSnapshot(navigationUrl, uploadResult.navigationBlocked);
  }
  if (!uploadResult.success) {
    throw new Error(`Failed to transfer file to browser: ${uploadResult.error || "Unknown error"}`);
  }

  return {
    fileName: uploadResult.fileName ?? fileName,
    size: typeof uploadResult.size === "number" ? uploadResult.size : fileContent.length,
  };
}

export function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",

    ".json": "application/json",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".jsx": "text/javascript",
    ".tsx": "text/typescript",
    ".py": "text/x-python",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
    ".h": "text/x-c",
    ".hpp": "text/x-c++",
    ".sh": "text/x-sh",
    ".bash": "text/x-sh",

    ".html": "text/html",
    ".css": "text/css",
    ".xml": "text/xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",

    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",

    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",

    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".7z": "application/x-7z-compressed",
  };

  return mimeTypes[ext] || "application/octet-stream";
}
