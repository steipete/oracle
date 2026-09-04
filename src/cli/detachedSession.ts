import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface DetachedSessionSpawnSpec {
  command: string;
  args: string[];
  options: SpawnOptions;
}

export interface LaunchDetachedSessionOptions {
  sessionId: string;
  cliEntrypoint?: string;
  env?: NodeJS.ProcessEnv;
  nodeExecutable?: string;
  prepare: (pid: number) => Promise<void>;
  spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

export function resolveOracleCliEntrypoint(moduleUrl: string = import.meta.url): string {
  const extension = fileURLToPath(moduleUrl).endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(new URL(`../../bin/oracle-cli.${extension}`, moduleUrl));
}

export function buildDetachedSessionSpawnSpec({
  sessionId,
  cliEntrypoint = resolveOracleCliEntrypoint(),
  env = process.env,
  nodeExecutable = process.execPath,
}: Omit<LaunchDetachedSessionOptions, "prepare" | "spawnProcess">): DetachedSessionSpawnSpec {
  return {
    command: nodeExecutable,
    args: ["--", cliEntrypoint, "--exec-session", sessionId],
    options: {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: {
        ...env,
        ORACLE_DETACHED_START_GATE: "1",
      },
      windowsHide: true,
    },
  };
}

export function launchDetachedSession({
  sessionId,
  cliEntrypoint,
  env,
  nodeExecutable,
  prepare,
  spawnProcess = spawn,
}: LaunchDetachedSessionOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      const spec = buildDetachedSessionSpawnSpec({
        sessionId,
        cliEntrypoint,
        env,
        nodeExecutable,
      });
      child = spawnProcess(spec.command, spec.args, spec.options);
    } catch (error) {
      reject(error);
      return;
    }

    child.once("error", reject);
    child.once("spawn", async () => {
      if (child.pid === undefined) {
        child.kill();
        reject(new Error("Detached session worker started without a process ID."));
        return;
      }
      try {
        await prepare(child.pid);
        if (!child.stdin) {
          throw new Error("Detached session worker started without a writable start gate.");
        }
        child.stdin.end("ready\n");
        child.unref();
        resolve(child.pid);
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
  });
}
