import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Minimal PTY helper shared across interactive tests (TUI + streaming).
// PTY is an optional local test helper; keep default installs native-free.
// biome-ignore lint/suspicious/noExplicitAny: PTY modules do not provide types
let pty: any | null = null;
try {
  const importPty = (specifier: string): Promise<unknown> => import(specifier);
  // Prefer the new package, fall back to the legacy one.
  // biome-ignore lint/suspicious/noExplicitAny: PTY modules do not provide types
  const mod: any = await importPty("@cdktf/node-pty-prebuilt-multiarch").catch(() =>
    importPty("@homebridge/node-pty-prebuilt-multiarch"),
  );
  pty = mod.default ?? mod;
} catch {
  pty = null;
}

export const ptyAvailable = Boolean(pty) && process.platform !== "linux";

export type PtyStep = {
  /** Substring or regex that must appear in the accumulated output to trigger this step. */
  match: string | RegExp;
  /** Text to write to the PTY once the match is seen (e.g., key sequences). */
  write?: string;
};

export interface RunPtyResult {
  output: string;
  exitCode: number | null;
  signal: number | null;
  homeDir: string;
}

/**
 * Spawn the compiled oracle CLI under a pseudo-TTY and drive it with scripted steps.
 * The caller is responsible for cleaning up the returned homeDir.
 */
export async function runOracleTuiWithPty({
  steps,
  env: envOverrides = {},
  cols = 100,
  rows = 40,
  homeDir,
  killAfterMs,
}: {
  steps: PtyStep[];
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  homeDir?: string;
  killAfterMs?: number;
}): Promise<RunPtyResult> {
  if (!pty) {
    throw new Error("PTY module not available");
  }

  const home = homeDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "oracle-tui-")));
  const entry = path.join(process.cwd(), "dist/bin/oracle-cli.js");
  const env = {
    ...process.env,
    // Uppercase env names are intentional for CLI behavior.
    // biome-ignore lint/style/useNamingConvention: env keys stay uppercase
    ORACLE_FORCE_TUI: "1",
    // biome-ignore lint/style/useNamingConvention: env keys stay uppercase
    ORACLE_HOME_DIR: home,
    // biome-ignore lint/style/useNamingConvention: env keys stay uppercase
    FORCE_COLOR: "1",
    // biome-ignore lint/style/useNamingConvention: env keys stay uppercase
    CI: "",
    ...envOverrides,
  } satisfies Record<string, string | undefined>;

  const ps = pty.spawn(process.execPath, [entry], {
    name: "xterm-color",
    cols,
    rows,
    cwd: process.cwd(),
    env,
  });

  let output = "";
  const pending = [...steps];
  const startedAt = Date.now();

  const maybeFlushSteps = (): void => {
    while (pending.length > 0) {
      const step = pending[0];
      const matched =
        typeof step.match === "string" ? output.includes(step.match) : step.match.test(output);
      const elapsed = Date.now() - startedAt;
      // Fall back to a time-based trigger so the PTY never hangs if the prompt text shifts.
      if (!matched && elapsed < 1_000) {
        break;
      }
      if (step.write) {
        try {
          ps.write(step.write);
        } catch {
          // Ignore write errors if PTY closes between match and write.
        }
      }
      if (matched) {
        pending.shift();
      } else {
        // Keep the step so we retry on the next interval once more output arrives.
        break;
      }
    }
  };

  const flushInterval = setInterval(maybeFlushSteps, 200);

  const killTimer =
    typeof killAfterMs === "number" && killAfterMs > 0
      ? setTimeout(() => {
          try {
            ps.kill();
          } catch {
            // ignore
          }
        }, killAfterMs)
      : null;

  ps.onData((data: string) => {
    output += data;
    maybeFlushSteps();
  });

  const exit = await new Promise<{ exitCode: number | null; signal: number | null }>((resolve) => {
    ps.onExit((evt: { exitCode: number | null; signal: number | null }) => resolve(evt));
  });

  if (killTimer) {
    clearTimeout(killTimer);
  }
  clearInterval(flushInterval);

  return { output, ...exit, homeDir: home };
}
