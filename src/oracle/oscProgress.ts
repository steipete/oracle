import process from 'node:process';

export interface OscProgressOptions {
  label?: string;
  targetMs?: number;
  write?: (data: string) => void;
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
}

const OSC = '\u001b]9;4;';
const ST = '\u001b\\';

function sanitizeLabel(label: string): string {
  const withoutEscape = label.split('\u001b').join('');
  const withoutBellAndSt = withoutEscape.replaceAll('\u0007', '').replaceAll('\u009c', '');
  return withoutBellAndSt.replaceAll(']', '').trim();
}

export function supportsOscProgress(
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = process.stdout.isTTY,
): boolean {
  if (!isTty) {
    return false;
  }
  if (env.ORACLE_NO_OSC_PROGRESS === '1') {
    return false;
  }
  if (env.ORACLE_FORCE_OSC_PROGRESS === '1') {
    return true;
  }
  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();
  if (termProgram.includes('ghostty')) {
    return true;
  }
  if (termProgram.includes('wezterm')) {
    return true;
  }
  if (env.WT_SESSION) {
    return true; // Windows Terminal exposes this
  }
  return false;
}

export function startOscProgress(options: OscProgressOptions = {}): () => void {
  const { label = 'Waiting for OpenAI', targetMs = 10 * 60_000, write = (text) => process.stdout.write(text) } =
    options;
  if (!supportsOscProgress(options.env, options.isTty)) {
    return () => {};
  }
  const cleanLabel = sanitizeLabel(label);
  const target = Math.max(targetMs, 1_000);
  const send = (state: number, percent: number): void => {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    write(`${OSC}${state};${clamped};${cleanLabel}${ST}`);
  };

  const startedAt = Date.now();
  send(1, 0); // activate progress bar
  const timer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    const percent = Math.min(99, (elapsed / target) * 100);
    send(1, percent);
  }, 900);
  timer.unref?.();

  let stopped = false;
  return () => {
    // biome-ignore lint/nursery/noUnnecessaryConditions: multiple callers may try to stop
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
    send(0, 0); // clear the progress bar
  };
}
