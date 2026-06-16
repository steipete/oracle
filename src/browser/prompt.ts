import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserBundleFormat, FileSection, RunOracleOptions } from "../oracle.js";
import {
  readFiles,
  createFileSections,
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
  ".apk",
  ".br",
  ".bz2",
  ".dmg",
  ".ear",
  ".gz",
  ".ipa",
  ".jar",
  ".lz",
  ".lz4",
  ".pkg",
  ".rar",
  ".tar",
  ".tgz",
  ".war",
  ".whl",
  ".xz",
  ".zip",
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

  const rawUploadAttachments: BrowserAttachment[] = await Promise.all(
    rawUploadFiles.map(async ({ path: filePath }) => {
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
  const bundleFormat = runOptions.browserBundleFormat ?? "auto";

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
  }));
  const rawUploadBundleSources: BrowserBundleSource[] = rawUploadAttachments.map((attachment) => ({
    absolutePath: attachment.path,
    displayPath: attachment.displayPath,
  }));
  const allBundleSources = [...textBundleSources, ...rawUploadBundleSources];
  const attachments: BrowserAttachment[] = [...selectedPlan.attachments, ...rawUploadAttachments];

  const shouldBundle =
    selectedPlan.shouldBundle ||
    (bundleRequested && attachments.length > 0) ||
    attachments.length > 10;
  const resolvedBundleFormat = resolveBrowserBundleFormat(bundleFormat, {
    hasRawUploadFiles: rawUploadAttachments.length > 0,
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
    const fallbackShouldBundle =
      uploadPlan.shouldBundle ||
      (bundleRequested && fallbackAttachments.length > 0) ||
      fallbackAttachments.length > 10;
    if (fallbackShouldBundle) {
      const fallbackBundleFormat = resolveBrowserBundleFormat(bundleFormat, {
        hasRawUploadFiles: rawUploadAttachments.length > 0,
      });
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
    attachmentMode: shouldBundle ? "bundle" : selectedPlan.mode,
    fallback,
    bundled,
  };
}
