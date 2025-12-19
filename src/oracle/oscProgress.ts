import process from 'node:process';
import {
  startOscProgress as startOscProgressShared,
  supportsOscProgress as supportsOscProgressShared,
  type OscProgressOptions as OscProgressOptionsShared,
} from 'osc-progress';

export type OscProgressOptions = OscProgressOptionsShared;

export function supportsOscProgress(
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = process.stdout.isTTY,
): boolean {
  return supportsOscProgressShared(env, isTty, {
    disableEnvVar: 'ORACLE_NO_OSC_PROGRESS',
    forceEnvVar: 'ORACLE_FORCE_OSC_PROGRESS',
  });
}

export function startOscProgress(options: OscProgressOptions = {}): () => void {
  return startOscProgressShared({
    ...options,
    // Preserve Oracle's previous default: progress emits to stdout.
    write: options.write ?? ((text) => process.stdout.write(text)),
    disableEnvVar: 'ORACLE_NO_OSC_PROGRESS',
    forceEnvVar: 'ORACLE_FORCE_OSC_PROGRESS',
  });
}

