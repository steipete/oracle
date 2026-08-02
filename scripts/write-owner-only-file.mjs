import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  statSync,
  writeSync,
} from "node:fs";

/**
 * Write a local file and enforce owner-only permissions (0600).
 *
 * Secure the destination *before* writing secret bytes: open/truncate,
 * fchmod the descriptor to 0600, then write. `writeFileSync` mode only
 * applies on create, so an existing permissive file must not receive
 * payload bytes until the descriptor is owner-only.
 *
 * @param {string} filePath
 * @param {string | Uint8Array} contents
 * @param {{ beforeWrite?: (filePath: string) => void }} [options]
 *        Optional probe (tests): runs after the descriptor is secured,
 *        before any payload bytes are written.
 */
export function writeOwnerOnlyFile(filePath, contents, options = {}) {
  let fd;
  try {
    fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);

    if (process.platform !== "win32") {
      fchmodSync(fd, 0o600);
      const mode = fstatSync(fd).mode & 0o777;
      if (mode !== 0o600) {
        throw new Error(`expected mode 0600 for ${filePath}, got ${mode.toString(8)}`);
      }
    }

    options.beforeWrite?.(filePath);

    if (typeof contents === "string") {
      writeSync(fd, contents, "utf8");
    } else {
      writeSync(fd, contents);
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }

  if (process.platform !== "win32") {
    const mode = statSync(filePath).mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`expected mode 0600 for ${filePath}, got ${mode.toString(8)}`);
    }
  }
}
