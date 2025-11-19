import type { EngineMode } from './engine.js';
import type { ModelName } from '../oracle.js';
import { PRO_MODELS } from '../oracle.js';

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
  // Only Pro-tier API runs should start detached by default; everything else stays inline for clarity.
  if (PRO_MODELS.has(model as Parameters<typeof PRO_MODELS.has>[0])) return true;
  return false;
}
