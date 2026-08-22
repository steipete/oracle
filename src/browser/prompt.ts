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
import {
  buildAttachmentBasenameCollisionDetails,
  findAttachmentBasenameCollisions,
  formatAttachmentBasenameCollisionMessage,
} from "./attachmentValidation.js";

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
type BrowserBundleScope = "none" | "text-only" | "all";

function formatSectionsForBundle(
  sections: Array<{ displayPath: string; content: string }>,
  options: { lineNumbers?: boolean } = {},
): string {
  return formatFileSections(sections, {
    lineNumbers: options.lineNumbers ?? true,
    trailingNewline: true,
  });
}

function resolveBrowserBundleFormat(format: BrowserBundleFormat): ResolvedBrowserBundleFormat {
  if (format !== "auto") {
    return format;
  }
  return "zip";
}

function resolveBrowserBundleScope(
  format: ResolvedBrowserBundleFormat,
  {
    bundleRequested,
    rawAttachmentCount,
    textAttachmentCount,
  }: {
    bundleRequested: boolean;
    rawAttachmentCount: number;
    textAttachmentCount: number;
  },
): BrowserBundleScope {
  const attachmentCount = textAttachmentCount + rawAttachmentCount;
  if (attachmentCount === 0) {
    return "none";
  }

  if (format === "text") {
    if (textAttachmentCount === 0) {
      return "none";
    }
    const shouldBundleText =
      bundleRequested || textAttachmentCount > 1 || attachmentCount > MAX_BROWSER_ATTACHMENTS;
    return shouldBundleText ? "text-only" : "none";
  }

  if (bundleRequested) {
    return "all";
  }

  // Preserve native uploads for images, PDFs, archives, and other raw inputs.
  // Multiple text/source files benefit from a real filesystem tree, so bundle
  // those into one ZIP while leaving any native attachments alongside it.
  if (textAttachmentCount > 1) {
    return rawAttachmentCount + 1 <= MAX_BROWSER_ATTACHMENTS ? "text-only" : "all";
  }

  return attachmentCount > MAX_BROWSER_ATTACHMENTS ? "all" : "none";
}

function appendZipBundleInstruction(composerText: string, originalCount: number): string {
  const fileLabel = originalCount === 1 ? "file" : "files";
  const instruction = [
    `The attached \`attachments-bundle.zip\` contains ${originalCount} selected ${fileLabel} with relative paths preserved.`,
    "Extract it into a temporary directory, then inspect the resulting file tree with filesystem and search tools before answering.",
  ].join(" ");
  return [composerText, instruction].filter(Boolean).join("\n\n").trim();
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

function assertUniqueAttachmentBasenames(attachments: BrowserAttachment[], cwd: string): void {
  const collisions = findAttachmentBasenameCollisions(attachments);
  if (collisions.length === 0) return;

  const details = buildAttachmentBasenameCollisionDetails(collisions, (attachment) =>
    path.isAbsolute(attachment.path) ? attachment.path : path.resolve(cwd, attachment.path),
  );
  throw new FileValidationError(
    formatAttachmentBasenameCollisionMessage("Browser upload", details.collisions),
    { ...details },
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

  const resolvedBundleFormat = resolveBrowserBundleFormat(bundleFormat);
  const bundleScope = resolveBrowserBundleScope(resolvedBundleFormat, {
    bundleRequested,
    rawAttachmentCount: rawUploadAttachments.length,
    textAttachmentCount: selectedPlan.attachments.length,
  });
  const shouldBundle = bundleScope !== "none";
  let composerText = (
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
      bundleScope === "all" ? allBundleSources : textBundleSources,
      resolvedBundleFormat,
    );
    bundleText = writtenBundle.tokenEstimateText;
    attachments.length = 0;
    attachments.push(writtenBundle.attachment);
    if (bundleScope === "text-only") {
      attachments.push(...rawUploadAttachments);
    }
    bundled = writtenBundle.metadata;
    if (resolvedBundleFormat === "zip") {
      composerText = appendZipBundleInstruction(composerText, writtenBundle.metadata.originalCount);
    }
  }
  assertAttachmentCount(attachments, resolvedBundleFormat);
  assertUniqueAttachmentBasenames(attachments, cwd);

  const inlineFileCount = shouldBundle ? 0 : selectedPlan.inlineFileCount;
  const modelConfig = isKnownModel(runOptions.model)
    ? MODEL_CONFIGS[runOptions.model]
    : MODEL_CONFIGS["gpt-5.1"];
  const tokenizer = deps.tokenizeImpl ?? modelConfig.tokenizer;
  const tokenizerUserSections = [userPrompt];
  if (inlineFileCount > 0 && selectedPlan.inlineBlock) {
    tokenizerUserSections.push(selectedPlan.inlineBlock);
  }
  if (shouldBundle && resolvedBundleFormat === "zip" && bundled) {
    tokenizerUserSections.push(appendZipBundleInstruction("", bundled.originalCount));
  }
  const tokenizerUserContent = tokenizerUserSections
    .filter((value) => Boolean(value?.trim()))
    .join("\n\n")
    .trim();
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
    let fallbackComposerText = baseComposerSections.join("\n\n").trim();
    const fallbackAttachments = [...uploadPlan.attachments, ...rawUploadAttachments];
    let fallbackBundled: BrowserBundleMetadata | null = null;
    const fallbackBundleFormat = resolveBrowserBundleFormat(bundleFormat);
    const fallbackBundleScope = resolveBrowserBundleScope(fallbackBundleFormat, {
      bundleRequested,
      rawAttachmentCount: rawUploadAttachments.length,
      textAttachmentCount: uploadPlan.attachments.length,
    });
    const fallbackShouldBundle = fallbackBundleScope !== "none";
    if (fallbackShouldBundle) {
      const writtenBundle = await writeBrowserBundle(
        sections,
        fallbackBundleScope === "all" ? allBundleSources : textBundleSources,
        fallbackBundleFormat,
      );
      fallbackAttachments.length = 0;
      fallbackAttachments.push(writtenBundle.attachment);
      if (fallbackBundleScope === "text-only") {
        fallbackAttachments.push(...rawUploadAttachments);
      }
      fallbackBundled = writtenBundle.metadata;
      if (fallbackBundleFormat === "zip") {
        fallbackComposerText = appendZipBundleInstruction(
          fallbackComposerText,
          writtenBundle.metadata.originalCount,
        );
      }
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
