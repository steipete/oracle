import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserBundleFormat, FileSection, RunOracleOptions } from "../oracle.js";
import {
  readFiles,
  createFileSections,
  FileValidationError,
  MODEL_CONFIGS,
  TOKENIZER_OPTIONS,
  formatFileSections,
} from "../oracle.js";
import { isKnownModel } from "../oracle/modelResolver.js";
import { buildPromptMarkdown } from "../oracle/promptAssembly.js";
import type { BrowserAttachment } from "./types.js";
import { buildAttachmentPlan } from "./policies.js";
import { createStoredZip } from "./zipBundle.js";

const DEFAULT_BROWSER_INLINE_CHAR_BUDGET = 60_000;
const MAX_BROWSER_ATTACHMENTS = 10;
const MAX_BROWSER_ZIP_BUNDLE_BYTES = 128 * 1024 * 1024;

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

const ARCHIVE_EXTENSIONS = new Set([
  ".7z",
  ".aab",
  ".apk",
  ".br",
  ".bz2",
  ".cab",
  ".crx",
  ".deb",
  ".dmg",
  ".doc",
  ".docx",
  ".ear",
  ".epub",
  ".gz",
  ".ipa",
  ".iso",
  ".jar",
  ".lz",
  ".lz4",
  ".msi",
  ".odp",
  ".ods",
  ".odt",
  ".pkg",
  ".ppt",
  ".pptx",
  ".rar",
  ".rpm",
  ".tar",
  ".tgz",
  ".war",
  ".whl",
  ".xls",
  ".xlsx",
  ".xz",
  ".xpi",
  ".zip",
  ".zipx",
  ".zst",
]);

export function isMediaFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return MEDIA_EXTENSIONS.has(ext);
}

export function isRawUploadFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return MEDIA_EXTENSIONS.has(ext) || ARCHIVE_EXTENSIONS.has(ext);
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

interface BrowserBundleSource {
  absolutePath: string;
  displayPath: string;
  sizeBytes: number;
}

type ResolvedBrowserBundleFormat = Exclude<BrowserBundleFormat, "auto">;

function formatSectionsForBundle(
  sections: Array<{ displayPath: string; content: string }>,
  options: { lineNumbers?: boolean } = {},
): string {
  return formatFileSections(sections, {
    lineNumbers: options.lineNumbers ?? true,
    trailingNewline: true,
  });
}

function resolveBrowserBundleFormat(
  format: BrowserBundleFormat,
  sources: { hasRawUploadFiles: boolean },
): ResolvedBrowserBundleFormat {
  if (format !== "auto") {
    return format;
  }
  return sources.hasRawUploadFiles ? "zip" : "text";
}

function shouldWriteBrowserBundle(
  format: ResolvedBrowserBundleFormat,
  {
    attachmentCount,
    bundleRequested,
    textSourceCount,
    textPlanShouldBundle,
  }: {
    attachmentCount: number;
    bundleRequested: boolean;
    textSourceCount: number;
    textPlanShouldBundle: boolean;
  },
): boolean {
  if (format === "zip") {
    return (
      textPlanShouldBundle ||
      (bundleRequested && attachmentCount > 0) ||
      attachmentCount > MAX_BROWSER_ATTACHMENTS
    );
  }
  return textSourceCount > 0 && (textPlanShouldBundle || attachmentCount > MAX_BROWSER_ATTACHMENTS);
}

function assertAttachmentCount(
  attachments: BrowserAttachment[],
  format: BrowserBundleFormat,
): void {
  if (attachments.length <= MAX_BROWSER_ATTACHMENTS) return;
  throw new Error(
    `Browser upload has ${attachments.length} attachments after applying bundle format "${format}". Use --browser-bundle-format auto or zip to stay within the ${MAX_BROWSER_ATTACHMENTS}-attachment limit.`,
  );
}

async function writeBrowserBundle(
  sections: FileSection[],
  sources: BrowserBundleSource[],
  format: ResolvedBrowserBundleFormat,
): Promise<WrittenBrowserBundle> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-browser-bundle-"));
  const tokenEstimateText = formatSectionsForBundle(sections, {
    lineNumbers: format === "text",
  });
  if (format === "zip") {
    const totalSourceBytes = sources.reduce((total, source) => total + source.sizeBytes, 0);
    if (totalSourceBytes > MAX_BROWSER_ZIP_BUNDLE_BYTES) {
      throw new Error(
        `Browser ZIP bundle inputs exceed the ${MAX_BROWSER_ZIP_BUNDLE_BYTES}-byte in-memory limit.`,
      );
    }
    const bundlePath = path.join(bundleDir, "attachments-bundle.zip");
    const buffer = createStoredZip(
      await Promise.all(
        sources.map(async (source) => ({
          path: source.displayPath,
          content: await fs.readFile(source.absolutePath),
        })),
      ),
    );
    await fs.writeFile(bundlePath, buffer);
    return {
      attachment: {
        path: bundlePath,
        displayPath: bundlePath,
        sizeBytes: buffer.length,
        generatedBundle: true,
      },
      metadata: { originalCount: sources.length, bundlePath, format },
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
      generatedBundle: true,
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
  const discoveredFiles =
    allFilePaths.length > 0
      ? await readFilesFn(allFilePaths, {
          cwd,
          maxFileSizeBytes: 0,
          readContents: false,
        })
      : [];
  const textFilePaths = discoveredFiles
    .filter((file) => !isRawUploadFile(file.path))
    .map((file) => file.path);
  const rawUploadFiles = discoveredFiles.filter((file) => isRawUploadFile(file.path));
  const maxFileSizeBytes = runOptions.maxFileSizeBytes;

  const rawUploadAttachments: BrowserAttachment[] = await Promise.all(
    rawUploadFiles.map(async ({ path: filePath }) => {
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      const stats = await fs.stat(resolvedPath);
      if (maxFileSizeBytes && stats.size > maxFileSizeBytes) {
        throw new FileValidationError(
          `The following file exceeds the ${maxFileSizeBytes}-byte limit:\n- ${
            path.relative(cwd, resolvedPath) || resolvedPath
          } (${stats.size} bytes)`,
          {
            files: [resolvedPath],
            limitBytes: maxFileSizeBytes,
          },
        );
      }
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
  const bundleFormat = runOptions.browserBundleFormat ?? "auto";
  if (attachmentsPolicy === "never" && rawUploadAttachments.length > 0) {
    throw new FileValidationError(
      "Raw or binary files cannot be pasted inline when browser attachments are disabled. Use --browser-attachments auto or always.",
      { files: rawUploadAttachments.map((attachment) => attachment.displayPath) },
    );
  }

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

  const textBundleSources: BrowserBundleSource[] = sections.map((section) => ({
    absolutePath: section.absolutePath,
    displayPath: section.displayPath,
    sizeBytes: Buffer.byteLength(section.content, "utf8"),
  }));
  const rawUploadBundleSources: BrowserBundleSource[] = rawUploadAttachments.map((attachment) => ({
    absolutePath: attachment.path,
    displayPath: attachment.displayPath,
    sizeBytes: attachment.sizeBytes ?? 0,
  }));
  const allBundleSources = [...textBundleSources, ...rawUploadBundleSources];
  const attachments: BrowserAttachment[] = [...selectedPlan.attachments, ...rawUploadAttachments];

  const resolvedBundleFormat = resolveBrowserBundleFormat(bundleFormat, {
    hasRawUploadFiles: rawUploadAttachments.length > 0,
  });
  const shouldBundle = shouldWriteBrowserBundle(resolvedBundleFormat, {
    attachmentCount: attachments.length,
    bundleRequested,
    textSourceCount: textBundleSources.length,
    textPlanShouldBundle: selectedPlan.shouldBundle,
  });
  const composerText = (
    !shouldBundle && selectedPlan.inlineBlock
      ? [...baseComposerSections, selectedPlan.inlineBlock]
      : baseComposerSections
  )
    .filter(Boolean)
    .join("\n\n")
    .trim();

  let bundleText: string | null = null;
  let bundled: BrowserBundleMetadata | null = null;
  if (shouldBundle) {
    const writtenBundle = await writeBrowserBundle(
      sections,
      resolvedBundleFormat === "zip" ? allBundleSources : textBundleSources,
      resolvedBundleFormat,
    );
    bundleText = writtenBundle.tokenEstimateText;
    attachments.length = 0;
    attachments.push(writtenBundle.attachment);
    if (resolvedBundleFormat === "text") {
      attachments.push(...rawUploadAttachments);
    }
    bundled = writtenBundle.metadata;
  }
  assertAttachmentCount(attachments, resolvedBundleFormat);

  const inlineFileCount = shouldBundle ? 0 : selectedPlan.inlineFileCount;
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
    const attachmentText = bundleText ?? formatFileSections(sections, { lineNumbers: false });
    const attachmentTokens = tokenizer(
      [{ role: "user", content: attachmentText }],
      TOKENIZER_OPTIONS,
    );
    estimatedInputTokens += attachmentTokens;
  }

  let fallback: BrowserPromptArtifacts["fallback"] = null;
  if (attachmentsPolicy === "auto" && selectedPlan.mode === "inline" && sections.length > 0) {
    const fallbackComposerText = baseComposerSections.join("\n\n").trim();
    const fallbackAttachments = [...uploadPlan.attachments, ...rawUploadAttachments];
    let fallbackBundled: BrowserBundleMetadata | null = null;
    const fallbackBundleFormat = resolveBrowserBundleFormat(bundleFormat, {
      hasRawUploadFiles: rawUploadAttachments.length > 0,
    });
    const fallbackShouldBundle = shouldWriteBrowserBundle(fallbackBundleFormat, {
      attachmentCount: fallbackAttachments.length,
      bundleRequested,
      textSourceCount: textBundleSources.length,
      textPlanShouldBundle: uploadPlan.shouldBundle,
    });
    if (fallbackShouldBundle) {
      const writtenBundle = await writeBrowserBundle(
        sections,
        fallbackBundleFormat === "zip" ? allBundleSources : textBundleSources,
        fallbackBundleFormat,
      );
      fallbackAttachments.length = 0;
      fallbackAttachments.push(writtenBundle.attachment);
      if (fallbackBundleFormat === "text") {
        fallbackAttachments.push(...rawUploadAttachments);
      }
      fallbackBundled = writtenBundle.metadata;
    }
    assertAttachmentCount(fallbackAttachments, fallbackBundleFormat);
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
    attachmentMode: shouldBundle
      ? "bundle"
      : attachments.length > 0
        ? "upload"
        : selectedPlan.mode === "bundle"
          ? "inline"
          : selectedPlan.mode,
    fallback,
    bundled,
  };
}
