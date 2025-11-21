import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Optional PTY dependency (same approach as streaming.pty.test.ts)
let ptyAvailable = true;
// biome-ignore lint/suspicious/noExplicitAny: third-party pty module ships without types
let pty: any | null = null;
try {
  // Prefer new package, fall back to legacy name.
  // biome-ignore lint/suspicious/noExplicitAny: third-party pty module ships without types
  const mod: any = await import('@cdktf/node-pty-prebuilt-multiarch').catch(() =>
    import('@homebridge/node-pty-prebuilt-multiarch'),
  );
  pty = mod.default ?? mod;
} catch {
  ptyAvailable = false;
}

const NODE_BIN = process.execPath;
// biome-ignore lint/nursery/noUnnecessaryConditions: PTY may be unavailable on some runners.
const ptyDescribe = ptyAvailable ? describe : describe.skip;

ptyDescribe('TUI (interactive, PTY)', () => {
  it(
    'renders the menu and exits cleanly when selecting Exit',
    async () => {
      const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-tui-'));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env keys stay uppercase
        ORACLE_FORCE_TUI: '1',
        // biome-ignore lint/style/useNamingConvention: env keys stay uppercase
        ORACLE_HOME_DIR: tmpHome,
        // biome-ignore lint/style/useNamingConvention: env keys stay uppercase
        FORCE_COLOR: '1',
        // biome-ignore lint/style/useNamingConvention: env keys stay uppercase
        CI: '', // make sure notifications default like local runs
      } satisfies Record<string, string | undefined>;

      // Ensure dist binary exists; tests that depend on PTY run after build in our scripts.
      const entry = path.join(process.cwd(), 'dist/bin/oracle-cli.js');

      const ps = pty.spawn(NODE_BIN, [entry], {
        name: 'xterm-color',
        cols: 100,
        rows: 40,
        cwd: process.cwd(),
        env,
      });

      let output = '';
      let wrote = false;
      ps.onData((d: string) => {
        output += d;
        if (!wrote && output.includes('Select a session or action')) {
          wrote = true;
          try {
            // Move to the Exit row (ask oracle -> ask oracle -> newer -> exit).
            ps.write('\u001b[B\u001b[B\u001b[B\r');
          } catch {
            // Ignore EIO if the PTY closes between detection and write.
          }
        }
      });

      const { exitCode } = await new Promise<{ exitCode: number | null; signal: number | null }>((resolve) => {
        ps.onExit((evt: { exitCode: number | null; signal: number | null }) => resolve(evt));
      });
      await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});

      expect(exitCode).toBe(0);
      expect(output).toContain('🧿 oracle');
      expect(output.toLowerCase()).toContain('closing the book');
    },
    20_000,
  );
});
