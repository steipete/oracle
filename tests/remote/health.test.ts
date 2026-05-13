import { describe, expect, test } from "vitest";
import { checkRemoteHealth, checkTcpConnection } from "../../src/remote/health.js";

describe("remote health checks", () => {
  test("reports invalid TCP host strings instead of throwing", async () => {
    await expect(checkTcpConnection("not-a-host-port", 10)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/host:port/i),
    });
  });

  test("reports invalid health host strings instead of throwing", async () => {
    await expect(
      checkRemoteHealth({ host: "127.0.0.1:not-a-port", token: "secret", timeoutMs: 10 }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/invalid port/i),
    });
  });
});
