import path from "node:path";
import type { ChromeClient, BrowserAttachment, BrowserLogger } from "../types.js";
import { FILE_INPUT_SELECTORS } from "../constants.js";
import { waitForAttachmentVisible } from "./attachments.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import { transferAttachmentViaDataTransfer } from "./attachmentDataTransfer.js";
import { beginAttachmentEvidence } from "./attachmentEvidence.js";

/**
 * Upload file to remote Chrome by transferring content via CDP
 * Used when browser is on a different machine than CLI
 */
export async function uploadAttachmentViaDataTransfer(
  deps: { runtime: ChromeClient["Runtime"]; dom?: ChromeClient["DOM"]; navigationUrl?: string },
  attachment: BrowserAttachment,
  logger: BrowserLogger,
): Promise<void> {
  const { runtime, dom } = deps;
  if (!dom) {
    throw new Error("DOM domain unavailable while uploading attachments.");
  }

  logger(`Transferring ${path.basename(attachment.path)} to remote browser...`);

  // The composer can mount before its file input; wait without dispatching an upload.
  const deadline = Date.now() + 15_000;
  let fileInputSelector: string | undefined;
  do {
    const documentNode = await dom.getDocument();
    for (const selector of FILE_INPUT_SELECTORS) {
      const result = await dom.querySelector({ nodeId: documentNode.root.nodeId, selector });
      if (result.nodeId) {
        fileInputSelector = selector;
        break;
      }
    }
    if (fileInputSelector) break;
    await delay(250);
  } while (Date.now() < deadline);

  if (!fileInputSelector) {
    await logDomFailure(runtime, logger, "file-input");
    throw new Error("Unable to locate ChatGPT file attachment input.");
  }

  const evidenceId = await beginAttachmentEvidence(runtime, path.basename(attachment.path));
  const transferResult = await transferAttachmentViaDataTransfer(
    runtime,
    attachment,
    fileInputSelector,
    deps.navigationUrl,
  );

  logger(`File transferred: ${transferResult.fileName} (${transferResult.size} bytes)`);

  // Give ChatGPT a moment to process the file
  await delay(500);
  // An assigned FileList proves our write, not that ChatGPT accepted it. A missing chip
  // cannot distinguish a drop from a slow upload, so never repeat this dispatch.
  await waitForAttachmentVisible(runtime, transferResult.fileName, 10_000, logger, evidenceId, {
    countFileInput: false,
  });

  logger("Attachment queued");
}
