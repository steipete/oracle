import type { EngineMode } from "./engine.js";
import type { ModelName, ReasoningMode } from "../oracle.js";
import { isProModel } from "../oracle/modelResolver.js";

export function shouldDetachSession({
  // Params kept for policy tweaks.
  engine,
  model,
  reasoningMode,
  waitPreference,
  disableDetachEnv,
}: {
  engine: EngineMode;
  model: ModelName;
  reasoningMode?: ReasoningMode;
  waitPreference: boolean;
  disableDetachEnv: boolean;
}): boolean {
  if (disableDetachEnv) return false;
  // Explicit --wait means "stay attached", regardless of model defaults.
  if (waitPreference) return false;
  // Only Pro-tier API runs should start detached by default; browser runs stay inline so failures surface.
  if ((isProModel(model) || reasoningMode === "pro") && engine === "api") return true;
  return false;
}
