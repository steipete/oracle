import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunOracleOptions } from "../oracle.js";
import {
  FileValidationError,
  readFiles,
  createFileSections,
  MODEL_CONFIGS,
  TOKENIZER_OPTIONS,
  formatFileSection,
} from "../oracle.js";
import { DEFAULT_MAX_FILE_SIZE_BYTES } from "../oracle/files.js";
import { isKnownModel } from "../oracle/modelResolver.js";
import { buildPromptMarkdown } from "../oracle/promptAssembly.js";
import type { BrowserAttachment } from "./types.js";
import { buildAttachmentPlan } from "./policies.js";
import { formatBytes } from "./utils.js";

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
  ".zip",
  ".tar",
  ".tgz",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
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
    bundled?: { originalCount: number; bundlePath: string } | null;
  } | null;
  bundled?: { originalCount: number; bundlePath: string } | null;
}

interface AssemblePromptDeps {
  cwd?: string;
  readFilesImpl?: typeof readFiles;
  tokenizeImpl?: (typeof MODEL_CONFIGS)["gpt-5.1"]["tokenizer"];
}

async function resolveBrowserInputFiles(
  filePaths: string[],
  cwd: string,
  maxFileSizeBytes: number,
  readFilesFn: typeof readFiles,
) {
  const resolved = await readFilesFn(filePaths, {
    cwd,
    maxFileSizeBytes,
    readContents: false,
  });
  const resolvedPaths = resolved.map((file) => file.path);
  const textPaths = resolvedPaths.filter((filePath) => !isMediaFile(filePath));
  const mediaPaths = resolvedPaths.filter((filePath) => isMediaFile(filePath));
  const files = textPaths.length > 0 ? await readFilesFn(textPaths, { cwd, maxFileSizeBytes }) : [];
  const mediaAttachments: BrowserAttachment[] = [];
  for (const resolvedPath of mediaPaths) {
    const stats = await fs.stat(resolvedPath);
    mediaAttachments.push({
      path: resolvedPath,
      displayPath: path.relative(cwd, resolvedPath) || path.basename(resolvedPath),
      sizeBytes: stats.size,
    });
  }
  return { files, mediaAttachments };
}

async function createBundleAttachment(
  sections: ReturnType<typeof createFileSections>,
  maxFileSizeBytes: number,
) {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-browser-bundle-"));
  const bundlePath = path.join(bundleDir, "attachments-bundle.txt");
  const bundleLines: string[] = [];
  sections.forEach((section) => {
    bundleLines.push(formatFileSection(section.displayPath, section.content).trimEnd());
    bundleLines.push("");
  });
  const bundleText = `${bundleLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
  const sizeBytes = Buffer.byteLength(bundleText, "utf8");
  if (maxFileSizeBytes && sizeBytes > maxFileSizeBytes) {
    throw new FileValidationError(
      `The following files exceed the ${formatBytes(maxFileSizeBytes)} limit:\n- attachments-bundle.txt (${formatBytes(sizeBytes)})`,
      {
        files: ["attachments-bundle.txt"],
        limitBytes: maxFileSizeBytes,
      },
    );
  }
  await fs.writeFile(bundlePath, bundleText, "utf8");
  return {
    text: bundleText,
    attachment: {
      path: bundlePath,
      displayPath: bundlePath,
      sizeBytes,
    } satisfies BrowserAttachment,
    bundled: { originalCount: sections.length, bundlePath },
  };
}

export async function assembleBrowserPrompt(
  runOptions: RunOracleOptions,
  deps: AssemblePromptDeps = {},
): Promise<BrowserPromptArtifacts> {
  const cwd = deps.cwd ?? process.cwd();
  const readFilesFn = deps.readFilesImpl ?? readFiles;
  const maxFileSizeBytes = runOptions.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;

  const allFilePaths = runOptions.file ?? [];
  const { files, mediaAttachments } = await resolveBrowserInputFiles(
    allFilePaths,
    cwd,
    maxFileSizeBytes,
    readFilesFn,
  );
  const basePrompt = (runOptions.prompt ?? "").trim();
  const userPrompt = basePrompt;
  const systemPrompt = runOptions.system?.trim() || "";
  const sections = createFileSections(files, cwd);
  const markdown = buildPromptMarkdown(systemPrompt, userPrompt, sections);

  const attachmentsPolicy: "auto" | "never" | "always" = runOptions.browserInlineFiles
    ? "never"
    : (runOptions.browserAttachments ?? "auto");
  const bundleRequested = Boolean(runOptions.browserBundleFiles);

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
  let bundled: { originalCount: number; bundlePath: string } | null = null;
  if (shouldBundle) {
    const bundle = await createBundleAttachment(sections, maxFileSizeBytes);
    bundleText = bundle.text;
    attachments.length = 0;
    attachments.push(bundle.attachment);
    attachments.push(...mediaAttachments);
    bundled = bundle.bundled;
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
    let fallbackBundled: { originalCount: number; bundlePath: string } | null = null;
    if (uploadPlan.shouldBundle) {
      const bundle = await createBundleAttachment(sections, maxFileSizeBytes);
      fallbackAttachments.length = 0;
      fallbackAttachments.push(bundle.attachment);
      fallbackAttachments.push(...mediaAttachments);
      fallbackBundled = bundle.bundled;
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
