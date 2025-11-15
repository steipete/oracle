import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { FileContent, FileSection, MinimalFsModule, FsStats } from './types.js';

const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB
const DEFAULT_FS = fs as MinimalFsModule;

interface PartitionedFiles {
  globPatterns: string[];
  excludePatterns: string[];
  literalFiles: string[];
  literalDirectories: string[];
}

export async function readFiles(
  filePaths: string[],
  { cwd = process.cwd(), fsModule = DEFAULT_FS, maxFileSizeBytes = MAX_FILE_SIZE_BYTES } = {},
): Promise<FileContent[]> {
  if (!filePaths || filePaths.length === 0) {
    return [];
  }

  const partitioned = await partitionFileInputs(filePaths, cwd, fsModule);
  const useNativeFilesystem = fsModule === DEFAULT_FS;

  let candidatePaths: string[] = [];
  if (useNativeFilesystem) {
    candidatePaths = await expandWithNativeGlob(partitioned, cwd);
  } else {
    if (partitioned.globPatterns.length > 0 || partitioned.excludePatterns.length > 0) {
      throw new Error('Glob patterns and exclusions are only supported for on-disk files.');
    }
    candidatePaths = await expandWithCustomFs(partitioned, fsModule);
  }

  if (candidatePaths.length === 0) {
    throw new Error('No files matched the provided --file patterns.');
  }

  const oversized: string[] = [];
  const accepted: string[] = [];
  for (const filePath of candidatePaths) {
    let stats: FsStats;
    try {
      stats = await fsModule.stat(filePath);
    } catch {
      throw new Error(`Missing file or directory: ${filePath}`);
    }
    if (!stats.isFile()) {
      continue;
    }
    if (maxFileSizeBytes && typeof stats.size === 'number' && stats.size > maxFileSizeBytes) {
      const relative = path.relative(cwd, filePath) || filePath;
      oversized.push(`${relative} (${formatBytes(stats.size)})`);
      continue;
    }
    accepted.push(filePath);
  }

  if (oversized.length > 0) {
    throw new Error(`The following files exceed the 1 MB limit:\n- ${oversized.join('\n- ')}`);
  }

  const files: FileContent[] = [];
  for (const filePath of accepted) {
    const content = await fsModule.readFile(filePath, 'utf8');
    files.push({ path: filePath, content });
  }
  return files;
}

async function partitionFileInputs(
  rawPaths: string[],
  cwd: string,
  fsModule: MinimalFsModule,
): Promise<PartitionedFiles> {
  const result: PartitionedFiles = {
    globPatterns: [],
    excludePatterns: [],
    literalFiles: [],
    literalDirectories: [],
  };

  for (const entry of rawPaths) {
    const raw = entry?.trim();
    if (!raw) {
      continue;
    }
    if (raw.startsWith('!')) {
      const normalized = normalizeGlob(raw.slice(1), cwd);
      if (normalized) {
        result.excludePatterns.push(normalized);
      }
      continue;
    }

    if (fg.isDynamicPattern(raw)) {
      result.globPatterns.push(normalizeGlob(raw, cwd));
      continue;
    }

    const absolutePath = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    let stats: FsStats;
    try {
      stats = await fsModule.stat(absolutePath);
    } catch {
      throw new Error(`Missing file or directory: ${raw}`);
    }
    if (stats.isDirectory()) {
      result.literalDirectories.push(absolutePath);
    } else if (stats.isFile()) {
      result.literalFiles.push(absolutePath);
    } else {
      throw new Error(`Not a file or directory: ${raw}`);
    }
  }

  return result;
}

async function expandWithNativeGlob(partitioned: PartitionedFiles, cwd: string): Promise<string[]> {
  const patterns = [
    ...partitioned.globPatterns,
    ...partitioned.literalFiles.map((absPath) => toPosixRelativeOrBasename(absPath, cwd)),
    ...partitioned.literalDirectories.map((absDir) => makeDirectoryPattern(toPosixRelative(absDir, cwd))),
  ].filter(Boolean);

  if (patterns.length === 0) {
    return [];
  }

  const matches = await fg(patterns, {
    cwd,
    absolute: true,
    dot: true,
    ignore: partitioned.excludePatterns,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  return Array.from(new Set(matches.map((match) => path.resolve(match))));
}

async function expandWithCustomFs(partitioned: PartitionedFiles, fsModule: MinimalFsModule): Promise<string[]> {
  const paths = new Set<string>();
  partitioned.literalFiles.forEach((file) => paths.add(file));
  for (const directory of partitioned.literalDirectories) {
    const nested = await expandDirectoryRecursive(directory, fsModule);
    nested.forEach((entry) => paths.add(entry));
  }
  return Array.from(paths);
}

async function expandDirectoryRecursive(directory: string, fsModule: MinimalFsModule): Promise<string[]> {
  const entries = await fsModule.readdir(directory);
  const results: string[] = [];
  for (const entry of entries) {
    const childPath = path.join(directory, entry);
    const stats = await fsModule.stat(childPath);
    if (stats.isDirectory()) {
      results.push(...(await expandDirectoryRecursive(childPath, fsModule)));
    } else if (stats.isFile()) {
      results.push(childPath);
    }
  }
  return results;
}

function makeDirectoryPattern(relative: string): string {
  if (relative === '.' || relative === '') {
    return '**/*';
  }
  return `${stripTrailingSlashes(relative)}/**/*`;
}

function normalizeGlob(pattern: string, cwd: string): string {
  if (!pattern) {
    return '';
  }
  let normalized = pattern;
  if (path.isAbsolute(normalized)) {
    normalized = path.relative(cwd, normalized);
  }
  normalized = toPosix(normalized);
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function toPosixRelative(absPath: string, cwd: string): string {
  const relative = path.relative(cwd, absPath);
  if (!relative) {
    return '.';
  }
  return toPosix(relative);
}

function toPosixRelativeOrBasename(absPath: string, cwd: string): string {
  const relative = path.relative(cwd, absPath);
  return toPosix(relative || path.basename(absPath));
}

function stripTrailingSlashes(value: string): string {
  const normalized = toPosix(value);
  return normalized.replace(/\/+$/g, '');
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${size} B`;
}

export function createFileSections(files: FileContent[], cwd = process.cwd()): FileSection[] {
  return files.map((file, index) => {
    const relative = path.relative(cwd, file.path) || file.path;
    const sectionText = [
      `### File ${index + 1}: ${relative}`,
      '```',
      file.content.trimEnd(),
      '```',
    ].join('\n');
    return {
      index: index + 1,
      absolutePath: file.path,
      displayPath: relative,
      sectionText,
      content: file.content,
    };
  });
}
