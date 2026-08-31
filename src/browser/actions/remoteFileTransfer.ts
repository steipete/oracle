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
  deps: { runtime: ChromeClient["Runtime"]; dom?: ChromeClient["DOM"] },
  attachment: BrowserAttachment,
  logger: BrowserLogger,
): Promise<void> {
  const { runtime, dom } = deps;
  if (!dom) {
    throw new Error("DOM domain unavailable while uploading attachments.");
  }

  logger(`Transferring ${path.basename(attachment.path)} to remote browser...`);

  // Find file input element
  const documentNode = await dom.getDocument();
  let fileInputSelector: string | undefined;

  for (const selector of FILE_INPUT_SELECTORS) {
    const result = await dom.querySelector({ nodeId: documentNode.root.nodeId, selector });
    if (result.nodeId) {
      fileInputSelector = selector;
      break;
    }
  }

  if (!fileInputSelector) {
    await logDomFailure(runtime, logger, "file-input");
    throw new Error("Unable to locate ChatGPT file attachment input.");
  }

  const evidenceId = await beginAttachmentEvidence(runtime, path.basename(attachment.path));
  const transferResult = await transferAttachmentViaDataTransfer(
    runtime,
    attachment,
    fileInputSelector,
  );

  logger(`File transferred: ${transferResult.fileName} (${transferResult.size} bytes)`);

  // Give ChatGPT a moment to process the file
  await delay(500);
  await waitForAttachmentVisible(runtime, transferResult.fileName, 10_000, logger, evidenceId);

  logger("Attachment queued");
}
