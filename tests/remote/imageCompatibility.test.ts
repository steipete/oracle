import http from "node:http";
import { expect, test } from "vitest";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";

const capabilities = {
  artifactTransfer: true,
  artifactProtocolVersion: 1,
  maxArtifactBytes: 1024,
  runCancellation: true,
};

test.each([
  [404, undefined],
  [200, undefined],
  [200, capabilities],
  [200, { ...capabilities, generatedImages: "true" }],
  [200, { ...capabilities, generatedImages: true, artifactProtocolVersion: 2 }],
  [401, { ...capabilities, generatedImages: true }],
])(
  "refuses image requests before sending anything to an incapable host (%s, %j)",
  async (statusCode, advertised) => {
    let requests = 0;
    let authenticated = false;
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        authenticated = req.headers.authorization === "Bearer fixture-token";
        res.writeHead(statusCode as number, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, capabilities: advertised }));
        return;
      }
      requests++;
      res.end(JSON.stringify({ type: "result", result: { answerText: "text only" } }) + "\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no address");
      const execute = createRemoteBrowserExecutor({
        host: `127.0.0.1:${address.port}`,
        token: "fixture-token",
      });
      await expect(
        execute({
          prompt: "draw a circle",
          config: {},
          generateImagePath: "/client/output.png",
          attachments: [{ path: "/must-not-read-before-negotiation", displayPath: "image.png" }],
        }),
      ).rejects.toThrow(/generated images.*upgrade/i);
      expect(requests).toBe(0);
      expect(authenticated).toBe(true);
      // Text-only callers retain compatibility with hosts that omit /health or image support.
      if (statusCode !== 401)
        expect((await execute({ prompt: "hello", config: {} })).answerText).toBe("text only");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
