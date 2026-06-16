import { spawn } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
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
 * cleanly — rsync exit 24 ("source files vanished") is tolerated.
 */
export async function copyChromeProfile(srcUserDataDir: string, destDir: string): Promise<void> {
  const srcDefault = path.join(srcUserDataDir, "Default");
  await mkdir(path.join(destDir, "Default"), { recursive: true });
  // `Local State` is required (holds the Keychain-wrapped key that decrypts the
  // cookies), so a copy failure must fail fast — otherwise the run continues with
  // a profile that silently looks logged-out.
  await cp(path.join(srcUserDataDir, "Local State"), path.join(destDir, "Local State")).catch(
    (err: unknown) => {
      throw new Error(
        `--copy-profile: could not copy required "Local State" from ${srcUserDataDir} ` +
          `(needed to decrypt the signed-in session): ${(err as Error).message}`,
      );
    },
  );
  const args = ["-a"];
  for (const exclude of RSYNC_EXCLUDES) {
    args.push("--exclude", exclude);
  }
  args.push(`${srcDefault}/`, `${path.join(destDir, "Default")}/`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("rsync", args, { stdio: "ignore" });
    child.on("error", (err) =>
      reject(
        new Error(
          `--copy-profile requires rsync on PATH (spawn failed): ${(err as Error).message}`,
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0 || code === 24
        ? resolve()
        : reject(new Error(`rsync failed copying Chrome profile (exit ${code})`)),
    );
  });
}
