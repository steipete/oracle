import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChromeClient, BrowserAttachment, BrowserLogger } from '../types.js';
import { FILE_INPUT_SELECTOR, GENERIC_FILE_INPUT_SELECTOR } from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure } from '../domDebug.js';

/**
 * Upload file to remote Chrome by transferring content via CDP
 * Used when browser is on a different machine than CLI
 */
export async function uploadAttachmentViaDataTransfer(
  deps: { runtime: ChromeClient['Runtime']; dom?: ChromeClient['DOM'] },
  attachment: BrowserAttachment,
  logger: BrowserLogger,
): Promise<void> {
  const { runtime, dom } = deps;
  if (!dom) {
    throw new Error('DOM domain unavailable while uploading attachments.');
  }

  // Read file content from local filesystem
  const fileContent = await readFile(attachment.path);

  // Enforce file size limit to avoid CDP protocol issues
  const MAX_BYTES = 20 * 1024 * 1024; // 20MB limit for CDP transfer
  if (fileContent.length > MAX_BYTES) {
    throw new Error(
      `Attachment ${path.basename(attachment.path)} is too large for remote upload (${fileContent.length} bytes). Maximum size is ${MAX_BYTES} bytes.`
    );
  }

  const base64Content = fileContent.toString('base64');
  const fileName = path.basename(attachment.path);
  const mimeType = guessMimeType(fileName);

  logger(`Transferring ${fileName} (${fileContent.length} bytes) to remote browser...`);

  // Find file input element
  const documentNode = await dom.getDocument();
  const selectors = [FILE_INPUT_SELECTOR, GENERIC_FILE_INPUT_SELECTOR];
  let fileInputSelector: string | undefined;

  for (const selector of selectors) {
    const result = await dom.querySelector({ nodeId: documentNode.root.nodeId, selector });
    if (result.nodeId) {
      fileInputSelector = selector;
      break;
    }
  }

  if (!fileInputSelector) {
    await logDomFailure(runtime, logger, 'file-input');
    throw new Error('Unable to locate ChatGPT file attachment input.');
  }

  // Inject file via JavaScript DataTransfer API
  const expression = `
    (function() {
      // Check for required file APIs
      if (!('File' in window) || !('Blob' in window) || !('DataTransfer' in window) || typeof atob !== 'function') {
        return { success: false, error: 'Required file APIs are not available in this browser' };
      }

      const fileInput = document.querySelector(${JSON.stringify(fileInputSelector)});
      if (!fileInput) {
        return { success: false, error: 'File input not found' };
      }

      // Validate that the element is actually a file input
      if (!(fileInput instanceof HTMLInputElement) || fileInput.type !== 'file') {
        return { success: false, error: 'Found element is not a file input' };
      }

      // Convert base64 to Blob
      const base64Data = ${JSON.stringify(base64Content)};
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: ${JSON.stringify(mimeType)} });

      // Create File object
      const file = new File([blob], ${JSON.stringify(fileName)}, {
        type: ${JSON.stringify(mimeType)},
        lastModified: Date.now()
      });

      // Create DataTransfer and assign to input
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;

      // Trigger both input and change events for better compatibility
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));

      return { success: true, fileName: file.name, size: file.size };
    })()
  `;

  const evalResult = await runtime.evaluate({ expression, returnByValue: true });

  // Check for JavaScript exceptions during evaluation
  if (evalResult.exceptionDetails) {
    const description = evalResult.exceptionDetails.text ?? 'JS evaluation failed';
    throw new Error(`Failed to transfer file to remote browser: ${description}`);
  }

  // Validate result structure before accessing
  if (!evalResult.result || typeof evalResult.result.value !== 'object' || evalResult.result.value == null) {
    throw new Error('Failed to transfer file to remote browser: unexpected evaluation result');
  }

  const uploadResult = evalResult.result.value as { success?: boolean; error?: string; fileName?: string; size?: number };

  if (!uploadResult.success) {
    throw new Error(`Failed to transfer file to remote browser: ${uploadResult.error || 'Unknown error'}`);
  }

  logger(`File transferred: ${uploadResult.fileName} (${uploadResult.size} bytes)`);

  // Give ChatGPT a moment to process the file
  await delay(500);
  logger(`Attachment queued: ${attachment.displayPath}`);
}


function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    // Text files
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',

    // Code files
    '.json': 'application/json',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.jsx': 'text/javascript',
    '.tsx': 'text/typescript',
    '.py': 'text/x-python',
    '.java': 'text/x-java',
    '.c': 'text/x-c',
    '.cpp': 'text/x-c++',
    '.h': 'text/x-c',
    '.hpp': 'text/x-c++',
    '.sh': 'text/x-sh',
    '.bash': 'text/x-sh',

    // Web files
    '.html': 'text/html',
    '.css': 'text/css',
    '.xml': 'text/xml',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',

    // Documents
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

    // Images
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',

    // Archives
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.7z': 'application/x-7z-compressed',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}
