import type { EngineMode } from './engine.js';
import type { ModelName } from '../oracle.js';

export function shouldDetachSession({
  // Params kept for future policy tweaks; currently only model/disableDetachEnv matter.
  engine: _engine,
  model,
  waitPreference: _waitPreference,
  disableDetachEnv,
}: {
  engine: EngineMode;
  model: ModelName;
  waitPreference: boolean;
  disableDetachEnv: boolean;
}): boolean {
  if (disableDetachEnv) return false;
  // Only GPT-5 Pro should start detached by default; everything else stays inline for clarity.
  if (model === 'gpt-5-pro') return true;
  return false;
}
