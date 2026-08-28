import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, test, vi } from "vitest";
import { resolveAttachRunningConnection } from "../../src/browser/attachRunning.js";

vi.mock("../../src/browser/detect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/browser/detect.js")>()),
  discoverDevToolsActivePortCandidates: vi.fn(async () => []),
}));

describe("attach-running HTTP body deadlines", () => {
  test.each([false, true])(
    "aborts a stalled response body and bounds the retry (second body stalls: %s)",
    async (stallRetry) => {
      let requests = 0;
      let abortedBodies = 0;
      const endpoint = "ws://127.0.0.1:9222/devtools/browser/retried";
      const server = createServer((_request, response) => {
        requests++;
        if (requests === 1 || stallRetry) {
          response.on("close", () => abortedBodies++);
          response.writeHead(200, { "content-type": "application/json" });
          response.flushHeaders();
          response.write("{");
          return;
        }
        response.end(JSON.stringify({ webSocketDebuggerUrl: endpoint }));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing HTTP test port");
      const pending = resolveAttachRunningConnection(
        { chromePath: null, remoteChrome: { host: "127.0.0.1", port: address.port } },
        () => {},
      );
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("Response body escaped probe deadline")),
          5000,
        );
      });
      try {
        const bounded = Promise.race([pending, deadline]);
        if (stallRetry) {
          await expect(bounded).rejects.toThrow(/endpoint probe .* failed: .*abort/i);
        } else {
          await expect(bounded).resolves.toMatchObject({
            browserWSEndpoint: endpoint,
            profileRoot: null,
          });
        }
        expect(requests).toBe(2);
        await vi.waitFor(() => expect(abortedBodies).toBe(stallRetry ? 2 : 1));
      } finally {
        clearTimeout(watchdog);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await pending.catch(() => undefined);
      }
    },
    10_000,
  );
});
