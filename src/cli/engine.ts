export type EngineMode = 'api' | 'browser';

export function defaultWaitPreference(model: string, engine: EngineMode): boolean {
  // gpt-5-pro (API) can take up to 10 minutes; default to non-blocking
  if (engine === 'api' && model === 'gpt-5-pro') {
    return false;
  }
  return true; // browser or gpt-5.1 are fast enough to block by default
}

/**
 * Determine which engine to use based on CLI flags and the environment.
 *
 * Precedence:
 * 1) Legacy --browser flag forces browser.
 * 2) Explicit --engine value.
 * 3) OPENAI_API_KEY decides: api when set, otherwise browser.
 */
export function resolveEngine(
  {
    engine,
    browserFlag,
    env,
  }: { engine?: EngineMode; browserFlag?: boolean; env: NodeJS.ProcessEnv },
): EngineMode {
  if (browserFlag) {
    return 'browser';
  }
  if (engine) {
    return engine;
  }
  return env.OPENAI_API_KEY ? 'api' : 'browser';
}
