import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Cache/derived subdirectories that bloat the copy and carry no signed-in-session
 * signal, so they are skipped when seeding a copied Chrome profile.
 */
const RSYNC_EXCLUDES = [
  "Cache/",
  "Code Cache/",
  "GPUCache/",
  "DawnGraphiteCache/",
  "DawnWebGPUCache/",
  "GrShaderCache/",
  "ShaderCache/",
  "Service Worker/CacheStorage/",
  "Service Worker/ScriptCache/",
  "Service Worker/Database/",
  "Sessions/",
  "Sessions_Encrypted/",
  "Session Storage/",
];

/**
 * Copy a signed-in Chrome user-data directory into `destDir` so a throwaway
 * Chrome can launch on the copy and reuse the live session WITHOUT a manual
 * sign-in. Copies the `Default/` profile (minus cache dirs) plus the top-level
 * `Local State` file.
 *
 * `Local State` is required: on macOS it holds the Keychain-wrapped
 * "Chrome Safe Storage" key that decrypts the profile's cookies — a cookies-only
 * copy fails the logged-in check. Decryption only succeeds when the copy is
 * launched by the real Chrome binary (the one on the Keychain ACL).
 *
 * Uses rsync (present on macOS/Linux) so a live, in-use source profile copies
 * cleanly — rsync exit 24 ("source files vanished") is tolerated. macOS ships
 * openrsync, which reports the same vanished-source condition as exit 23
 * ("partial transfer") where GNU rsync uses 24, so exit 23 is tolerated only
 * when every reported error is a vanished-file error; genuine read failures
 * (EACCES and friends) stay fatal, and a tolerated partial copy must still
 * contain the auth storage present in the source.
 */
export async function copyChromeProfile(
  srcUserDataDir: string,
  destDir: string,
  requestedProfile?: string | null,
): Promise<string> {
  try {
    const localStatePath = path.join(srcUserDataDir, "Local State");
    const copiedLocalStatePath = path.join(destDir, "Local State");
    await cp(localStatePath, copiedLocalStatePath).catch((err: unknown) => {
      throw new Error(
        `--copy-profile: could not copy required "Local State" from ${srcUserDataDir} ` +
          `(needed to select and decrypt the signed-in profile): ${(err as Error).message}`,
      );
    });
    const localState = await readFile(copiedLocalStatePath, "utf8");
    const profileDirectory = resolveChromeProfileDirectory(
      srcUserDataDir,
      localState,
      requestedProfile,
    );
    const srcProfile = path.join(srcUserDataDir, profileDirectory);
    const destProfile = path.join(destDir, profileDirectory);
    await mkdir(destProfile, { recursive: true });
    // `Local State` is required (holds the Keychain-wrapped key that decrypts the
    // cookies), so a copy failure must fail fast — otherwise the run continues with
    // a profile that silently looks logged-out.
    const authStorage = await srcAuthFiles(srcProfile);
    const args = ["-a"];
    for (const exclude of RSYNC_EXCLUDES) {
      args.push("--exclude", exclude);
    }
    args.push(`${srcProfile}/`, `${destProfile}/`);
    const stderrChunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn("rsync", args, { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (err) =>
        reject(
          new Error(
            `--copy-profile requires rsync on PATH (spawn failed): ${(err as Error).message}`,
          ),
        ),
      );
      child.on("close", (code) => {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (classifyRsyncExit(code, stderr) === "ok") {
          resolve();
        } else {
          reject(
            new Error(
              `rsync failed copying Chrome profile (exit ${code})${stderr.trim() ? `: ${stderr.trim().split("\n")[0]}` : ""}`,
            ),
          );
        }
      });
    });
    // A tolerated partial copy may have skipped a file that vanished mid-copy.
    // If that file carried the session, continuing would produce a profile that
    // silently looks logged-out — verify auth storage survived the copy.
    for (const name of authStorage) {
      await stat(path.join(destProfile, name)).catch(() => {
        throw new Error(
          `--copy-profile: copied profile is missing ${JSON.stringify(name)} present in the source (partial transfer); refusing a logged-out copy.`,
        );
      });
    }
    return profileDirectory;
  } catch (error) {
    // The destination is always a newly-created throwaway profile. Remove partial
    // session-bearing copies before surfacing setup failures.
    await rm(destDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Files that carry the signed-in session inside a Chrome profile directory. */
const AUTH_STORAGE_NAMES = ["Cookies", "Network/Cookies", "Login Data", "Web Data"];

async function srcAuthFiles(srcProfile: string): Promise<string[]> {
  const present: string[] = [];
  for (const name of AUTH_STORAGE_NAMES) {
    if (
      await stat(path.join(srcProfile, name)).then(
        () => true,
        () => false,
      )
    ) {
      present.push(name);
    }
  }
  return present;
}

// Vanished-source diagnostics emitted by GNU rsync and macOS openrsync. Only
// lines carrying a vanished-file reason may be ignored; any other error —
// including "Permission denied" — must keep exit 23 fatal (#540).
const VANISHED_LINE = /: No such file or directory(?: \(2\))?$/;
const GNU_VANISHED_LINE = /^file has vanished: "/;
const SUMMARY_LINE =
  /^rsync (?:error: some files\/attrs were not transferred|warning: some files vanished before they could be transferred) \(see previous errors\) \(code (?:23|24)\)(?: at .*)?$/;

/**
 * Whether an rsync exit code may be treated as a successful-enough copy:
 * 0 and 24 always; 23 only when stderr is non-empty and every non-summary line
 * reports a vanished source file (openrsync maps that condition onto 23).
 */
function classifyRsyncExit(code: number | null, stderr: string): "ok" | "fatal" {
  if (code === 0 || code === 24) return "ok";
  if (code !== 23) return "fatal";
  const errors = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !SUMMARY_LINE.test(line));
  return errors.length > 0 &&
    errors.every((line) => VANISHED_LINE.test(line) || GNU_VANISHED_LINE.test(line))
    ? "ok"
    : "fatal";
}

export function classifyRsyncExitForTest(code: number | null, stderr: string): "ok" | "fatal" {
  return classifyRsyncExit(code, stderr);
}

function resolveChromeProfileDirectory(
  srcUserDataDir: string,
  localState: string,
  requestedProfile?: string | null,
): string {
  let profile = requestedProfile?.trim();
  if (!profile) {
    try {
      const parsed = JSON.parse(localState) as { profile?: { last_used?: unknown } };
      profile =
        typeof parsed.profile?.last_used === "string" ? parsed.profile.last_used.trim() : "";
    } catch (error) {
      throw new Error(
        `--copy-profile: could not parse "Local State" to select the active Chrome profile: ${(error as Error).message}`,
      );
    }
  }
  profile ||= "Default";

  const root = path.resolve(srcUserDataDir);
  const resolved = path.resolve(root, profile);
  if (path.dirname(resolved) !== root) {
    throw new Error(
      `--copy-profile: Chrome profile must be a direct child of the user-data directory; received ${JSON.stringify(profile)}.`,
    );
  }
  return path.basename(resolved);
}

export function resolveChromeProfileDirectoryForTest(
  srcUserDataDir: string,
  localState: string,
  requestedProfile?: string | null,
): string {
  return resolveChromeProfileDirectory(srcUserDataDir, localState, requestedProfile);
}
