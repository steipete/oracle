import { chmodSync, statSync, writeFileSync } from "node:fs";

/**
 * Write a local file and enforce owner-only permissions (0600).
 * `writeFileSync` mode only applies on create; chmod repairs an existing
 * permissive destination after overwrite.
 */
export function writeOwnerOnlyFile(filePath, contents) {
  writeFileSync(filePath, contents, { mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(filePath, 0o600);
    const mode = statSync(filePath).mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`expected mode 0600 for ${filePath}, got ${mode.toString(8)}`);
    }
  }
}
