import fs from "node:fs";
import path from "node:path";
import type { RunOracleOptions } from "../oracle.js";
import type { EngineMode } from "../cli/engine.js";
import type { UserConfig } from "../config.js";
import { resolveRunOptionsFromConfig } from "../cli/runOptions.js";
import { getOracleHomeDir } from "../oracleHome.js";
import { Launcher } from "chrome-launcher";

const ALLOW_EXTERNAL_OUTPUT_ENV = "ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT";
const MCP_OUTPUT_DIRNAME = "generated";

/**
 * Whether MCP callers may write generated images outside the dedicated Oracle
 * output directory. Off by default: MCP clients are less trusted than CLI users.
 */
export function isExternalMcpOutputAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ALLOW_EXTERNAL_OUTPUT_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Resolve `target` through symlinks for the portion that exists on disk, then
 * re-append the not-yet-created remainder. A lexical `path.resolve` is not
 * enough: a symlinked parent under the Oracle home (e.g. `~/.oracle/generated`
 * -> `/tmp/evil`) would pass a string-prefix check while the actual write lands
 * outside the boundary. realpath-ing the deepest existing ancestor closes that.
 */
function resolveThroughSymlinks(target: string): string {
  const resolved = path.resolve(target);
  let current = resolved;
  const tail: string[] = [];
  // Bounded by the number of path segments; dirname() converges to the root.
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new Error(`MCP output path contains an unresolved symlink: ${current}`);
        }
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw lstatError;
        }
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Constrain an MCP-supplied output path to ORACLE_HOME_DIR/generated and return
 * its canonical absolute form. This keeps agent writes away from Oracle config,
 * session metadata, and browser profile state. Existing symlinks are resolved
 * before the boundary check. Set ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT to opt into
 * arbitrary output paths as an explicit operator decision.
 */
export function resolveMcpOutputPath(
  requestedPath: string,
  field: "generateImage" | "outputPath",
  env: NodeJS.ProcessEnv = process.env,
): string {
  const resolved = path.resolve(requestedPath);
  if (isExternalMcpOutputAllowed(env)) {
    return resolved;
  }
  const oracleHome = resolveThroughSymlinks(getOracleHomeDir());
  const root = path.join(oracleHome, MCP_OUTPUT_DIRNAME);
  const realTarget = resolveThroughSymlinks(resolved);
  if (realTarget.startsWith(`${root}${path.sep}`)) {
    return realTarget;
  }
  throw new Error(
    `MCP "${field}" must resolve under the generated output directory (${root}); got "${realTarget}". ` +
      `Use a path under that directory, or set ${ALLOW_EXTERNAL_OUTPUT_ENV}=1 to allow external output paths.`,
  );
}

export function mapConsultToRunOptions({
  prompt,
  files,
  model,
  models,
  engine,
  search,
  browserAttachments,
  browserBundleFiles,
  browserBundleFormat,
  browserFollowUps,
  generateImage,
  outputPath,
  userConfig,
  env = process.env,
}: {
  prompt: string;
  files: string[];
  model?: string;
  models?: string[];
  engine?: EngineMode;
  search?: boolean;
  browserAttachments?: "auto" | "never" | "always";
  browserBundleFiles?: boolean;
  browserBundleFormat?: "auto" | "text" | "zip";
  browserFollowUps?: string[];
  generateImage?: string;
  outputPath?: string;
  userConfig?: UserConfig;
  env?: NodeJS.ProcessEnv;
}): { runOptions: RunOracleOptions; resolvedEngine: EngineMode } {
  // Normalize CLI-style inputs through the shared resolver so config/env defaults apply,
  // then overlay MCP-only overrides such as explicit search toggles.
  const mergedModels =
    Array.isArray(models) && models.length > 0
      ? [model, ...models].filter((entry): entry is string => Boolean(entry?.trim()))
      : models;
  const result = resolveRunOptionsFromConfig({
    prompt,
    files,
    model,
    models: mergedModels,
    engine,
    userConfig,
    env,
  });
  if (typeof search === "boolean") {
    result.runOptions.search = search;
  }
  if (browserAttachments) {
    result.runOptions.browserAttachments = browserAttachments;
  }
  if (typeof browserBundleFiles === "boolean") {
    result.runOptions.browserBundleFiles = browserBundleFiles;
  }
  if (browserBundleFormat) {
    result.runOptions.browserBundleFormat = browserBundleFormat;
  }
  if (Array.isArray(browserFollowUps)) {
    result.runOptions.browserFollowUps = browserFollowUps
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  const imageOutputPath = generateImage?.trim();
  if (imageOutputPath) {
    result.runOptions.generateImage = resolveMcpOutputPath(imageOutputPath, "generateImage", env);
  }
  const secondaryOutputPath = outputPath?.trim();
  if (secondaryOutputPath) {
    result.runOptions.outputPath = resolveMcpOutputPath(secondaryOutputPath, "outputPath", env);
  }
  if (
    result.resolvedEngine !== "browser" &&
    (result.runOptions.generateImage || result.runOptions.outputPath)
  ) {
    throw new Error('MCP image output requires engine:"browser".');
  }
  return result;
}

export function ensureBrowserAvailable(
  engine: EngineMode,
  options?: { remoteHost?: string | null },
): string | null {
  if (engine !== "browser") {
    return null;
  }
  const remoteHost = options?.remoteHost?.trim() || process.env.ORACLE_REMOTE_HOST?.trim();
  if (remoteHost) {
    return null;
  }
  if (process.env.CHROME_PATH) {
    return null;
  }
  const found = Launcher.getFirstInstallation();
  if (!found) {
    return "Browser engine unavailable: no Chrome installation found and CHROME_PATH is unset.";
  }
  return null;
}
