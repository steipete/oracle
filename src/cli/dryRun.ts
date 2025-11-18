import chalk from 'chalk';
import {
  MODEL_CONFIGS,
  TOKENIZER_OPTIONS,
  DEFAULT_SYSTEM_PROMPT,
  buildPrompt,
  readFiles,
  getFileTokenStats,
  printFileTokenStats,
  type RunOracleOptions,
  type PreviewMode,
} from '../oracle.js';
import { assembleBrowserPrompt, type BrowserPromptArtifacts } from '../browser/prompt.js';
import type { BrowserAttachment } from '../browser/types.js';
import { buildTokenEstimateSuffix, formatAttachmentLabel } from '../browser/promptSummary.js';

interface DryRunDeps {
  readFilesImpl?: typeof readFiles;
  assembleBrowserPromptImpl?: typeof assembleBrowserPrompt;
}

export async function runDryRunSummary(
  {
    engine,
    runOptions,
    cwd,
    version,
    log,
  }: {
    engine: 'api' | 'browser';
    runOptions: RunOracleOptions;
    cwd: string;
    version: string;
    log: (message: string) => void;
  },
  deps: DryRunDeps = {},
): Promise<void> {
  if (engine === 'browser') {
    await runBrowserDryRun({ runOptions, cwd, version, log }, deps);
    return;
  }
  await runApiDryRun({ runOptions, cwd, version, log }, deps);
}

async function runApiDryRun(
  {
    runOptions,
    cwd,
    version,
    log,
  }: {
    runOptions: RunOracleOptions;
    cwd: string;
    version: string;
    log: (message: string) => void;
  },
  deps: DryRunDeps,
): Promise<void> {
  const readFilesImpl = deps.readFilesImpl ?? readFiles;
  const files = await readFilesImpl(runOptions.file ?? [], { cwd });
  const systemPrompt = runOptions.system?.trim() || DEFAULT_SYSTEM_PROMPT;
  const combinedPrompt = buildPrompt(runOptions.prompt ?? '', files, cwd);
  const tokenizer = MODEL_CONFIGS[runOptions.model].tokenizer;
  const estimatedInputTokens = tokenizer(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: combinedPrompt },
    ],
    TOKENIZER_OPTIONS,
  );
  const headerLine = `[dry-run] Oracle (${version}) would call ${runOptions.model} with ~${estimatedInputTokens.toLocaleString()} tokens and ${files.length} files.`;
  log(chalk.cyan(headerLine));
  if (files.length === 0) {
    log(chalk.dim('[dry-run] No files matched the provided --file patterns.'));
    return;
  }
  const inputBudget = runOptions.maxInput ?? MODEL_CONFIGS[runOptions.model].inputLimit;
  const stats = getFileTokenStats(files, {
    cwd,
    tokenizer,
    tokenizerOptions: TOKENIZER_OPTIONS,
    inputTokenBudget: inputBudget,
  });
  printFileTokenStats(stats, { inputTokenBudget: inputBudget, log });
}

async function runBrowserDryRun(
  {
    runOptions,
    cwd,
    version,
    log,
  }: {
    runOptions: RunOracleOptions;
    cwd: string;
    version: string;
    log: (message: string) => void;
  },
  deps: DryRunDeps,
): Promise<void> {
  const assemblePromptImpl = deps.assembleBrowserPromptImpl ?? assembleBrowserPrompt;
  const artifacts = await assemblePromptImpl(runOptions, { cwd });
  const suffix = buildTokenEstimateSuffix(artifacts);
  const headerLine = `[dry-run] Oracle (${version}) would launch browser mode (${runOptions.model}) with ~${artifacts.estimatedInputTokens.toLocaleString()} tokens${suffix}.`;
  log(chalk.cyan(headerLine));
  logBrowserFileSummary(artifacts, log, 'dry-run');
}

function logBrowserFileSummary(artifacts: BrowserPromptArtifacts, log: (message: string) => void, label: string) {
  if (artifacts.attachments.length > 0) {
    const prefix = artifacts.bundled ? `[${label}] Bundled upload:` : `[${label}] Attachments to upload:`;
    log(chalk.bold(prefix));
    artifacts.attachments.forEach((attachment: BrowserAttachment) => {
      log(`  • ${formatAttachmentLabel(attachment)}`);
    });
    if (artifacts.bundled) {
      log(
        chalk.dim(
          `  (bundled ${artifacts.bundled.originalCount} files into ${artifacts.bundled.bundlePath})`,
        ),
      );
    }
    return;
  }
  if (artifacts.inlineFileCount > 0) {
    log(chalk.bold(`[${label}] Inline file content:`));
    log(`  • ${artifacts.inlineFileCount} file${artifacts.inlineFileCount === 1 ? '' : 's'} pasted directly into the composer.`);
    return;
  }
  log(chalk.dim(`[${label}] No files attached.`));
}

export async function runBrowserPreview(
  {
    runOptions,
    cwd,
    version,
    previewMode,
    log,
  }: {
    runOptions: RunOracleOptions;
    cwd: string;
    version: string;
    previewMode: PreviewMode;
    log: (message: string) => void;
  },
  deps: DryRunDeps = {},
): Promise<void> {
  const assemblePromptImpl = deps.assembleBrowserPromptImpl ?? assembleBrowserPrompt;
  const artifacts = await assemblePromptImpl(runOptions, { cwd });
  const suffix = buildTokenEstimateSuffix(artifacts);
  const headerLine = `[preview] Oracle (${version}) browser mode (${runOptions.model}) with ~${artifacts.estimatedInputTokens.toLocaleString()} tokens${suffix}.`;
  log(chalk.cyan(headerLine));
  logBrowserFileSummary(artifacts, log, 'preview');
  if (previewMode === 'json' || previewMode === 'full') {
    const attachmentSummary = artifacts.attachments.map((attachment) => ({
      path: attachment.path,
      displayPath: attachment.displayPath,
      sizeBytes: attachment.sizeBytes,
    }));
    const previewPayload = {
      model: runOptions.model,
      engine: 'browser' as const,
      composerText: artifacts.composerText,
      attachments: attachmentSummary,
      inlineFileCount: artifacts.inlineFileCount,
      bundled: artifacts.bundled,
      tokenEstimate: artifacts.estimatedInputTokens,
    };
    log('');
    log(chalk.bold('Preview JSON'));
    log(JSON.stringify(previewPayload, null, 2));
  }
  if (previewMode === 'full') {
    log('');
    log(chalk.bold('Composer Text'));
    log(artifacts.composerText || chalk.dim('(empty prompt)'));
  }
}
