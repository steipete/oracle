import path from "node:path";
import type { BrowserAttachment } from "./types.js";

export interface AttachmentBasenameCollision {
  basename: string;
  attachments: BrowserAttachment[];
}

export interface AttachmentBasenameCollisionDetail {
  basename: string;
  files: string[];
}

export interface AttachmentBasenameCollisionDetails {
  collisions: AttachmentBasenameCollisionDetail[];
  files: string[];
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function findAttachmentBasenameCollisions(
  attachments: BrowserAttachment[],
): AttachmentBasenameCollision[] {
  const attachmentsByBasename = new Map<string, BrowserAttachment[]>();
  for (const attachment of attachments) {
    const basename = path.basename(attachment.path);
    const matchingAttachments = attachmentsByBasename.get(basename) ?? [];
    matchingAttachments.push(attachment);
    attachmentsByBasename.set(basename, matchingAttachments);
  }

  return [...attachmentsByBasename.entries()]
    .filter(([, matchingAttachments]) => matchingAttachments.length > 1)
    .sort(([leftBasename], [rightBasename]) => compareStrings(leftBasename, rightBasename))
    .map(([basename, matchingAttachments]) => ({
      basename,
      attachments: [...matchingAttachments].sort(
        (left, right) =>
          compareStrings(left.displayPath, right.displayPath) ||
          compareStrings(left.path, right.path),
      ),
    }));
}

export function buildAttachmentBasenameCollisionDetails(
  collisions: AttachmentBasenameCollision[],
  displayFile: (attachment: BrowserAttachment) => string,
): AttachmentBasenameCollisionDetails {
  const collisionDetails = collisions.map((collision) => ({
    basename: collision.basename,
    files: collision.attachments.map(displayFile),
  }));
  return {
    collisions: collisionDetails,
    files: collisionDetails.flatMap((collision) => collision.files),
  };
}

export function formatAttachmentBasenameCollisionMessage(
  subject: string,
  collisions: AttachmentBasenameCollisionDetail[],
): string {
  const collisionLines =
    collisions.length === 1
      ? [
          `${subject} cannot safely include multiple files named "${collisions[0]!.basename}":`,
          ...collisions[0]!.files.map((file) => `- ${file}`),
        ]
      : [
          `${subject} cannot safely include files with colliding basenames:`,
          ...collisions.flatMap((collision) => [
            `Files named "${collision.basename}":`,
            ...collision.files.map((file) => `- ${file}`),
          ]),
        ];

  return [
    ...collisionLines,
    "Use --browser-bundle-files (and --browser-bundle-format zip for raw or binary files), or choose unique names before retrying.",
  ].join("\n");
}
