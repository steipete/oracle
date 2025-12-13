import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserRunOptions, BrowserRunResult, BrowserLogger } from '../browser/types.js';
import type { GeminiWebOptions, GeminiWebResponse, SpawnResult } from './types.js';

// biome-ignore lint/style/useNamingConvention: __dirname is standard Node.js ESM convention
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.resolve(__dirname, '../../vendor/gemini-webapi');
const WRAPPER_SCRIPT = path.join(VENDOR_DIR, 'wrapper.py');

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

async function spawnPython(args: string[], log?: BrowserLogger): Promise<SpawnResult> {
  const venvPython = path.join(VENDOR_DIR, '.venv', 'bin', 'python');
  const pythonPath = existsSync(venvPython) ? venvPython : 'python3';

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath, [WRAPPER_SCRIPT, ...args], {
      cwd: VENDOR_DIR,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (log) {
        for (const line of chunk.split('\n').filter(Boolean)) {
          log(`[gemini-web] ${line}`);
        }
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

async function spawnCommand(command: string, args: string[], cwd?: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: cwd ?? VENDOR_DIR });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

async function ensureVenvSetup(log?: BrowserLogger): Promise<void> {
  const venvPath = path.join(VENDOR_DIR, '.venv');

  if (existsSync(venvPath)) {
    return;
  }

  log?.('[gemini-web] First run: setting up Python environment...');

  await mkdir(VENDOR_DIR, { recursive: true });

  const createVenv = await spawnCommand('python3', ['-m', 'venv', venvPath]);
  if (createVenv.exitCode !== 0) {
    throw new Error(`Failed to create venv: ${createVenv.stderr}`);
  }

  const pipPath = path.join(venvPath, 'bin', 'pip');
  const requirementsPath = path.join(VENDOR_DIR, 'requirements.txt');

  const installResult = await spawnCommand(pipPath, ['install', '-r', requirementsPath]);
  if (installResult.exitCode !== 0) {
    throw new Error(`Failed to install dependencies: ${installResult.stderr}`);
  }

  log?.('[gemini-web] Python environment ready');
}

export function createGeminiWebExecutor(
  geminiOptions: GeminiWebOptions,
): (runOptions: BrowserRunOptions) => Promise<BrowserRunResult> {
  return async (runOptions: BrowserRunOptions): Promise<BrowserRunResult> => {
    const startTime = Date.now();
    const log = runOptions.log;

    log?.('[gemini-web] Starting Gemini WebAPI executor');

    await ensureVenvSetup(log);

    const args: string[] = [runOptions.prompt, '--json'];

    for (const attachment of runOptions.attachments ?? []) {
      args.push('--file', attachment.path);
    }

    if (geminiOptions.youtube) {
      args.push('--youtube', geminiOptions.youtube);
    }
    if (geminiOptions.generateImage) {
      args.push('--generate-image', geminiOptions.generateImage);
    }
    if (geminiOptions.editImage) {
      args.push('--edit', geminiOptions.editImage);
    }
    if (geminiOptions.outputPath) {
      args.push('--output', geminiOptions.outputPath);
    }
    if (geminiOptions.aspectRatio) {
      args.push('--aspect', geminiOptions.aspectRatio);
    }
    if (geminiOptions.showThoughts) {
      args.push('--show-thoughts');
    }

    log?.(`[gemini-web] Calling wrapper with ${args.length} args`);

    const result = await spawnPython(args, log);

    if (result.exitCode !== 0) {
      const errorMsg = result.stderr || 'Unknown error from Gemini WebAPI';
      throw new Error(`Gemini WebAPI failed: ${errorMsg}`);
    }

    let response: GeminiWebResponse;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      if (result.stdout.trim()) {
        response = { text: result.stdout.trim(), thoughts: null, has_images: false, image_count: 0 };
      } else {
        throw new Error(`Failed to parse Gemini response: ${result.stdout}`);
      }
    }

    if (response.error) {
      throw new Error(`Gemini error: ${response.error}`);
    }

    const answerText = response.text ?? '';
    let answerMarkdown = answerText;

    if (geminiOptions.showThoughts && response.thoughts) {
      answerMarkdown = `## Thinking\n\n${response.thoughts}\n\n## Response\n\n${answerText}`;
    }

    if (response.has_images && response.image_count > 0) {
      const imagePath = geminiOptions.generateImage || geminiOptions.outputPath || 'generated.png';
      answerMarkdown += `\n\n*Generated ${response.image_count} image(s). Saved to: ${imagePath}*`;
    }

    const tookMs = Date.now() - startTime;
    log?.(`[gemini-web] Completed in ${tookMs}ms`);

    return {
      answerText,
      answerMarkdown,
      tookMs,
      answerTokens: estimateTokenCount(answerText),
      answerChars: answerText.length,
    };
  };
}
