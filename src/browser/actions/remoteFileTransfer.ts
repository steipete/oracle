import path from "node:path";
import type { ChromeClient, BrowserAttachment, BrowserLogger } from "../types.js";
import { FILE_INPUT_SELECTORS } from "../constants.js";
import { isAttachmentVisible, waitForAttachmentVisible } from "./attachments.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import { transferAttachmentViaDataTransfer } from "./attachmentDataTransfer.js";
import { beginAttachmentEvidence } from "./attachmentEvidence.js";

// ChatGPT shows the prompt box before it mounts and wires the composer's file inputs, and can
// re-render the composer while the page finishes loading. A transfer made in that window is
// dropped without a trace: no chip, no upload request. So wait for an input to exist, and repeat
// a transfer ChatGPT never picked up. An accepted transfer shows its chip within about a second.
const FILE_INPUT_WAIT_MS = 15_000;
const PICKUP_WAIT_MS = 3_000;
const MAX_TRANSFERS = 3;

export interface RemoteTransferTiming {
  inputWaitMs?: number;
  pickupWaitMs?: number;
}

/**
 * Upload file to remote Chrome by transferring content via CDP
 * Used when browser is on a different machine than CLI
 */
export async function uploadAttachmentViaDataTransfer(
  deps: { runtime: ChromeClient["Runtime"]; dom?: ChromeClient["DOM"]; navigationUrl?: string },
  attachment: BrowserAttachment,
  logger: BrowserLogger,
  timing: RemoteTransferTiming = {},
): Promise<void> {
  const { runtime, dom } = deps;
  if (!dom) {
    throw new Error("DOM domain unavailable while uploading attachments.");
  }

  logger(`Transferring ${path.basename(attachment.path)} to remote browser...`);

  for (let transfer = 1; ; transfer += 1) {
    const fileInputSelector = await waitForFileInputSelector(
      dom,
      timing.inputWaitMs ?? FILE_INPUT_WAIT_MS,
    );
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
    if (
      transfer < MAX_TRANSFERS &&
      !(await waitForPickup(
        runtime,
        transferResult.fileName,
        timing.pickupWaitMs ?? PICKUP_WAIT_MS,
        evidenceId,
      ))
    ) {
      logger(
        `ChatGPT did not pick up ${transferResult.fileName}; transferring it again (${transfer + 1}/${MAX_TRANSFERS}).`,
      );
      continue;
    }
    await waitForAttachmentVisible(runtime, transferResult.fileName, 10_000, logger, evidenceId);

    logger("Attachment queued");
    return;
  }
}

async function waitForFileInputSelector(
  dom: ChromeClient["DOM"],
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const documentNode = await dom.getDocument();
    for (const selector of FILE_INPUT_SELECTORS) {
      const result = await dom.querySelector({ nodeId: documentNode.root.nodeId, selector });
      if (result.nodeId) {
        return selector;
      }
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await delay(250);
  }
}

async function waitForPickup(
  runtime: ChromeClient["Runtime"],
  fileName: string,
  timeoutMs: number,
  evidenceId: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isAttachmentVisible(runtime, fileName, evidenceId)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(200);
  }
}
