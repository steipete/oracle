import { spawn } from "node:child_process";

export interface LaunchDetachedSessionRunnerOptions {
  cliEntrypoint: string;
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
}

export function launchDetachedSessionRunner(
  sessionId: string,
  options: LaunchDetachedSessionRunnerOptions,
): Promise<boolean> {
  return launchDetachedCli(["--exec-session", sessionId], options);
}

export function launchDetachedSessionFinalizer(
  sessionId: string,
  options: LaunchDetachedSessionRunnerOptions,
): Promise<boolean> {
  return launchDetachedCli(["--finalize-session", sessionId], options);
}

function launchDetachedCli(
  cliArgs: string[],
  {
    cliEntrypoint,
    env = process.env,
    nodeExecPath = process.execPath,
  }: LaunchDetachedSessionRunnerOptions,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(nodeExecPath, ["--", cliEntrypoint, ...cliArgs], {
        detached: true,
        stdio: "ignore",
        env,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch (error) {
      reject(error);
    }
  });
}
