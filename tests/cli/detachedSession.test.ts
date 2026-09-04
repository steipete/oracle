import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import {
  buildDetachedSessionSpawnSpec,
  launchDetachedSession,
  resolveOracleCliEntrypoint,
} from "../../src/cli/detachedSession.js";

describe("detached session launcher", () => {
  test("uses a hidden detached Node child with a gated session handoff", () => {
    const spec = buildDetachedSessionSpawnSpec({
      sessionId: "long-pro-session",
      cliEntrypoint: "C:\\oracle\\dist\\bin\\oracle-cli.js",
      env: { EXISTING: "1" },
      nodeExecutable: "C:\\node\\node.exe",
    });

    expect(spec).toMatchObject({
      command: "C:\\node\\node.exe",
      args: ["--", "C:\\oracle\\dist\\bin\\oracle-cli.js", "--exec-session", "long-pro-session"],
      options: {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
        env: {
          EXISTING: "1",
          ORACLE_DETACHED_START_GATE: "1",
        },
      },
    });
  });

  test("resolves the built CLI next to the dist source tree", () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "dist", "src", "cli", "detachedSession.js"),
    ).href;
    expect(resolveOracleCliEntrypoint(moduleUrl)).toBe(
      path.join(process.cwd(), "dist", "bin", "oracle-cli.js"),
    );
  });

  test("opens the start gate only after durable lifecycle preparation", async () => {
    const stdin = new PassThrough();
    const written: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => written.push(chunk));
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdin,
      unref: vi.fn(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const prepare = vi.fn(async () => undefined);
    const spawnProcess = vi.fn(() => child);

    const launched = launchDetachedSession({
      sessionId: "long-pro-session",
      prepare,
      spawnProcess,
    });
    child.emit("spawn");

    await expect(launched).resolves.toBe(4242);
    expect(prepare).toHaveBeenCalledWith(4242);
    expect(Buffer.concat(written).toString("utf8")).toBe("ready\n");
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
