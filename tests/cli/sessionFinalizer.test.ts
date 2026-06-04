import { afterEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { sessionStore } from "../../src/sessionStore.js";
import { finalizeBrowserSessionUntilComplete } from "../../src/cli/sessionFinalizer.js";

afterEach(() => {
  setOracleHomeDirOverrideForTest(null);
});

async function withOracleHome<T>(fn: (tmpHome: string) => Promise<T>): Promise<T> {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-finalizer-"));
  setOracleHomeDirOverrideForTest(tmpHome);
  try {
    return await fn(tmpHome);
  } finally {
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
}

describe("browser session finalizer", () => {
  test("treats an errored browser session with a captured transcript as completed", async () => {
    await withOracleHome(async () => {
      const session = await sessionStore.createSession(
        {
          prompt: "ask oracle",
          model: "gpt-5.5-pro",
          mode: "browser",
          browserConfig: { manualLogin: true },
        },
        "/tmp/project",
        undefined,
        "saved-transcript-after-wrapper-error",
      );
      const paths = await sessionStore.getPaths(session.id);
      const transcriptPath = path.join(paths.dir, "artifacts", "transcript.md");
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "## Answer\n\nThe answer was already captured.\n", "utf8");
      await sessionStore.updateSession(session.id, {
        status: "error",
        completedAt: new Date().toISOString(),
        errorMessage: "TypeError: setTypeOfService EINVAL",
        response: { status: "error" },
        error: {
          category: "browser",
          message: "TypeError: setTypeOfService EINVAL",
        },
      });

      const result = await finalizeBrowserSessionUntilComplete(session.id, {
        firstWaitMs: 0,
        maxWaitMs: 0,
      });
      const updated = await sessionStore.readSession(session.id);

      expect(result).toBe("completed");
      expect(updated?.status).toBe("completed");
      expect(updated?.errorMessage).toBeUndefined();
      expect(updated?.response).toEqual({ status: "completed" });
      expect(updated?.artifacts?.[0]).toMatchObject({
        kind: "transcript",
        path: transcriptPath,
      });
    });
  });

  test("keeps recovering past a 15 minute client impatience window", async () => {
    await withOracleHome(async () => {
      const session = await sessionStore.createSession(
        {
          prompt: "long browser prompt",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: { manualLogin: true },
        },
        "/tmp/project",
        undefined,
        "long-haul-stale-running",
      );
      await sessionStore.updateSession(session.id, {
        status: "running",
        startedAt: new Date().toISOString(),
      });

      const paths = await sessionStore.getPaths(session.id);
      const transcriptPath = path.join(paths.dir, "artifacts", "transcript.md");
      let currentMs = 0;
      const logs: string[] = [];
      const attachSessionFn = vi.fn(async () => {
        if (currentMs < 16 * 60_000) {
          return;
        }
        await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
        await fs.writeFile(
          transcriptPath,
          "## Answer\n\nRecovered after a long-running browser response.\n",
          "utf8",
        );
        await sessionStore.updateSession(session.id, {
          status: "completed",
          completedAt: new Date().toISOString(),
          artifacts: [
            {
              kind: "transcript",
              path: transcriptPath,
              label: "Browser transcript",
              mimeType: "text/markdown",
            },
          ],
          response: { status: "completed" },
        });
      });

      const result = await finalizeBrowserSessionUntilComplete(session.id, {
        now: () => currentMs,
        waitFn: async (ms) => {
          currentMs += ms;
        },
        attachSessionFn,
        log: (line) => logs.push(line),
      });
      const updated = await sessionStore.readSession(session.id);

      expect(result).toBe("completed");
      expect(currentMs).toBeGreaterThanOrEqual(17 * 60_000);
      expect(attachSessionFn).toHaveBeenCalledTimes(5);
      expect(updated?.status).toBe("completed");
      expect(updated?.artifacts?.[0]).toMatchObject({
        kind: "transcript",
        path: transcriptPath,
      });
      expect(logs).toEqual(
        expect.arrayContaining([
          "[finalizer] Waiting 5m 0s before first recovery render.",
          "[finalizer] Recovery render attempt 5 for long-haul-stale-running (running).",
          "[finalizer] Session long-haul-stale-running finalized as completed.",
        ]),
      );
    });
  });
});
