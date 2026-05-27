import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserBundleFormat, RunOracleOptions } from "../oracle.js";
import {
  readFiles,
  createFileSections,
  MODEL_CONFIGS,
  TOKENIZER_OPTIONS,
  formatFileSection,
} from "../oracle.js";
import { isKnownModel } from "../oracle/modelResolver.js";
import { buildPromptMarkdown } from "../oracle/promptAssembly.js";
import type { BrowserAttachment } from "./types.js";
import { buildAttachmentPlan } from "./policies.js";
import { createStoredZip } from "./zipBundle.js";

const DEFAULT_BROWSER_INLINE_CHAR_BUDGET = 60_000;

const MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
  ".mp3",
  ".wav",
  ".aac",
  ".flac",
  ".ogg",
  ".m4a",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".heic",
  ".heif",
  ".pdf",
]);

export function isMediaFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return MEDIA_EXTENSIONS.has(ext);
}

export interface BrowserPromptArtifacts {
  markdown: string;
  composerText: string;
  estimatedInputTokens: number;
  attachments: BrowserAttachment[];
  inlineFileCount: number;
  tokenEstimateIncludesInlineFiles: boolean;
  attachmentsPolicy: "auto" | "never" | "always";
  attachmentMode: "inline" | "upload" | "bundle";
  fallback?: {
    composerText: string;
    attachments: BrowserAttachment[];
    bundled?: BrowserBundleMetadata | null;
  } | null;
  bundled?: BrowserBundleMetadata | null;
}

export interface BrowserBundleMetadata {
  originalCount: number;
  bundlePath: string;
  format?: BrowserBundleFormat;
}

interface AssemblePromptDeps {
  cwd?: string;
  readFilesImpl?: typeof readFiles;
  tokenizeImpl?: (typeof MODEL_CONFIGS)["gpt-5.1"]["tokenizer"];
}

interface WrittenBrowserBundle {
  attachment: BrowserAttachment;
  metadata: BrowserBundleMetadata;
  tokenEstimateText: string;
}

function formatSectionsForBundle(
  sections: Array<{ displayPath: string; content: string }>,
): string {
  const bundleLines: string[] = [];
  sections.forEach((section) => {
    bundleLines.push(formatFileSection(section.displayPath, section.content).trimEnd());
    bundleLines.push("");
  });
  return `${bundleLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

async function writeBrowserBundle(
  sections: Array<{ displayPath: string; content: string }>,
  format: BrowserBundleFormat,
): Promise<WrittenBrowserBundle> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-browser-bundle-"));
  const tokenEstimateText = formatSectionsForBundle(sections);
  if (format === "zip") {
    const bundlePath = path.join(bundleDir, "attachments-bundle.zip");
    const buffer = createStoredZip(
      sections.map((section) => ({
        path: section.displayPath,
        content: section.content,
      })),
    );
    await fs.writeFile(bundlePath, buffer);
    return {
      attachment: {
        path: bundlePath,
        displayPath: bundlePath,
        sizeBytes: buffer.length,
      },
      metadata: { originalCount: sections.length, bundlePath, format },
      tokenEstimateText,
    };
  }
  const bundlePath = path.join(bundleDir, "attachments-bundle.txt");
  await fs.writeFile(bundlePath, tokenEstimateText, "utf8");
  return {
    attachment: {
      path: bundlePath,
      displayPath: bundlePath,
      sizeBytes: Buffer.byteLength(tokenEstimateText, "utf8"),
    },
    metadata: { originalCount: sections.length, bundlePath, format },
    tokenEstimateText,
  };
}

export async function assembleBrowserPrompt(
  runOptions: RunOracleOptions,
  deps: AssemblePromptDeps = {},
): Promise<BrowserPromptArtifacts> {
  const cwd = deps.cwd ?? process.cwd();
  const readFilesFn = deps.readFilesImpl ?? readFiles;

  const allFilePaths = runOptions.file ?? [];
  const textFilePaths = allFilePaths.filter((f) => !isMediaFile(f));
  const mediaFilePaths = allFilePaths.filter((f) => isMediaFile(f));

  const mediaAttachments: BrowserAttachment[] = await Promise.all(
    mediaFilePaths.map(async (filePath) => {
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      const stats = await fs.stat(resolvedPath);
      return {
        path: resolvedPath,
        displayPath: path.relative(cwd, resolvedPath) || path.basename(resolvedPath),
        sizeBytes: stats.size,
      };
    }),
  );

  const files = await readFilesFn(textFilePaths, {
    cwd,
    maxFileSizeBytes: runOptions.maxFileSizeBytes,
  });
  const basePrompt = (runOptions.prompt ?? "").trim();
  const userPrompt = basePrompt;
  const systemPrompt = runOptions.system?.trim() || "";
  const sections = createFileSections(files, cwd);
  const markdown = buildPromptMarkdown(systemPrompt, userPrompt, sections);

  const attachmentsPolicy: "auto" | "never" | "always" = runOptions.browserInlineFiles
    ? "never"
    : (runOptions.browserAttachments ?? "auto");
  const bundleRequested = Boolean(runOptions.browserBundleFiles);
  const bundleFormat = runOptions.browserBundleFormat ?? "text";

  const inlinePlan = buildAttachmentPlan(sections, { inlineFiles: true, bundleRequested });
  const uploadPlan = buildAttachmentPlan(sections, { inlineFiles: false, bundleRequested });

  const baseComposerSections: string[] = [];
  if (systemPrompt) baseComposerSections.push(systemPrompt);
  if (userPrompt) baseComposerSections.push(userPrompt);

  const inlineComposerText = [...baseComposerSections, inlinePlan.inlineBlock]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  const selectedPlan =
    attachmentsPolicy === "always"
      ? uploadPlan
      : attachmentsPolicy === "never"
        ? inlinePlan
        : inlineComposerText.length <= DEFAULT_BROWSER_INLINE_CHAR_BUDGET || sections.length === 0
          ? inlinePlan
          : uploadPlan;

  const composerText = (
    selectedPlan.inlineBlock
      ? [...baseComposerSections, selectedPlan.inlineBlock]
      : baseComposerSections
  )
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const attachments: BrowserAttachment[] = [...selectedPlan.attachments, ...mediaAttachments];

  const shouldBundle = selectedPlan.shouldBundle;
  let bundleText: string | null = null;
  let bundled: BrowserBundleMetadata | null = null;
  if (shouldBundle) {
    const writtenBundle = await writeBrowserBundle(sections, bundleFormat);
    bundleText = writtenBundle.tokenEstimateText;
    attachments.length = 0;
    attachments.push(writtenBundle.attachment);
    attachments.push(...mediaAttachments);
    bundled = writtenBundle.metadata;
  }

  const inlineFileCount = selectedPlan.inlineFileCount;
  const modelConfig = isKnownModel(runOptions.model)
    ? MODEL_CONFIGS[runOptions.model]
    : MODEL_CONFIGS["gpt-5.1"];
  const tokenizer = deps.tokenizeImpl ?? modelConfig.tokenizer;
  const tokenizerUserContent =
    inlineFileCount > 0 && selectedPlan.inlineBlock
      ? [userPrompt, selectedPlan.inlineBlock]
          .filter((value) => Boolean(value?.trim()))
          .join("\n\n")
          .trim()
      : userPrompt;
  const tokenizerMessages = [
    systemPrompt ? { role: "system", content: systemPrompt } : null,
    tokenizerUserContent ? { role: "user", content: tokenizerUserContent } : null,
  ].filter(Boolean) as Array<{ role: "system" | "user"; content: string }>;
  let estimatedInputTokens = tokenizer(
    tokenizerMessages.length > 0 ? tokenizerMessages : [{ role: "user", content: "" }],
    TOKENIZER_OPTIONS,
  );
  const tokenEstimateIncludesInlineFiles = inlineFileCount > 0 && Boolean(selectedPlan.inlineBlock);
  if (!tokenEstimateIncludesInlineFiles && sections.length > 0) {
    const attachmentText =
      bundleText ??
      sections
        .map((section) => formatFileSection(section.displayPath, section.content).trimEnd())
        .join("\n\n");
    const attachmentTokens = tokenizer(
      [{ role: "user", content: attachmentText }],
      TOKENIZER_OPTIONS,
    );
    estimatedInputTokens += attachmentTokens;
  }

  let fallback: BrowserPromptArtifacts["fallback"] = null;
  if (attachmentsPolicy === "auto" && selectedPlan.mode === "inline" && sections.length > 0) {
    const fallbackComposerText = baseComposerSections.join("\n\n").trim();
    const fallbackAttachments = [...uploadPlan.attachments, ...mediaAttachments];
    let fallbackBundled: BrowserBundleMetadata | null = null;
    if (uploadPlan.shouldBundle) {
      const writtenBundle = await writeBrowserBundle(sections, bundleFormat);
      fallbackAttachments.length = 0;
      fallbackAttachments.push(writtenBundle.attachment);
      fallbackAttachments.push(...mediaAttachments);
      fallbackBundled = writtenBundle.metadata;
    }
    fallback = {
      composerText: fallbackComposerText,
      attachments: fallbackAttachments,
      bundled: fallbackBundled,
    };
  }

  return {
    markdown,
    composerText,
    estimatedInputTokens,
    attachments,
    inlineFileCount,
    tokenEstimateIncludesInlineFiles,
    attachmentsPolicy,
    attachmentMode: selectedPlan.mode,
    fallback,
    bundled,
  };
}
