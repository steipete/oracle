import type { SessionLifecycleMetadata, SessionMetadata } from "../sessionManager.js";
import type { EngineMode } from "./engine.js";

export interface BuildSessionLifecycleOptions {
  engine: EngineMode;
  detached: boolean;
  reattachCommand: string;
}

export function buildSessionLifecycle({
  engine,
  detached,
  reattachCommand,
}: BuildSessionLifecycleOptions): SessionLifecycleMetadata {
  return {
    engine,
    execution: detached ? "background" : "foreground",
    attached: !detached,
    detached,
    reattachCommand,
  };
}

export function formatSessionLifecycleBlock(meta: SessionMetadata): string[] {
  const lifecycle = meta.lifecycle;
  if (!lifecycle) {
    return [];
  }
  const modelCount = meta.models?.length ?? (meta.model ? 1 : 0);
  const detachValue = lifecycle.detached
    ? lifecycle.execution === "background"
      ? "yes, polling"
      : "yes"
    : "no";
  const lines = [
    `Session: ${meta.id}`,
    `Mode: ${lifecycle.engine} ${lifecycle.execution}`,
    `Models: ${modelCount > 1 ? `${modelCount} parallel` : String(modelCount || 1)}`,
    `Detach: ${detachValue}`,
    `Reattach: ${lifecycle.reattachCommand}`,
  ];
  return lines;
}

export function formatSessionExecutionLabel(meta: SessionMetadata): string {
  const lifecycle = meta.lifecycle;
  if (!lifecycle) {
    return meta.mode ?? meta.options?.mode ?? "api";
  }
  const engine = lifecycle.engine === "browser" ? "br" : lifecycle.engine;
  const execution = lifecycle.execution === "background" ? "bg" : "fg";
  return `${engine}/${execution}`;
}
