import type { EngineMode } from "./engine.js";
import type { ModelName } from "../oracle.js";
import { isProModel } from "../oracle/modelResolver.js";

export function shouldDetachSession({
  // Params kept for policy tweaks.
  engine,
  model,
  waitPreference,
  disableDetachEnv,
}: {
  engine: EngineMode;
  model: ModelName;
  waitPreference: boolean;
  disableDetachEnv: boolean;
}): boolean {
  if (disableDetachEnv) return false;
  // Keep long local browser Pro work in a separate process even while the CLI
  // stays attached to its session log. If the foreground stream is interrupted,
  // the worker can still finish the browser run and persist the answer.
  if (engine === "browser" && isProModel(model)) return true;
  // For API runs, explicit --wait keeps execution in the foreground.
  if (waitPreference) return false;
  // Pro-tier API runs start detached by default.
  if (isProModel(model) && engine === "api") return true;
  return false;
}

export function stopDetachedWorker(
  workerPid: number,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): boolean {
  try {
    kill(workerPid, "SIGTERM");
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
