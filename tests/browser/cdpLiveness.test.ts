import { describe, expect, test } from "vitest";

import {
  connectionLostUserMessage,
  isRecoverableChromeDisconnect,
  probeChromeTargetLiveness,
} from "../../src/browser/cdpLiveness.ts";

describe("cdpLiveness", () => {
  test("reports unreachable when DevTools endpoint probe fails", async () => {
    const liveness = await probeChromeTargetLiveness({
      host: "127.0.0.1",
      port: 9222,
      targetId: "T1",
      verifyEndpoint: async () => ({ ok: false, error: "ECONNREFUSED" }),
    });
    expect(liveness).toEqual({
      endpointReachable: false,
      targetFound: null,
      error: "ECONNREFUSED",
    });
    expect(isRecoverableChromeDisconnect(liveness)).toBe(false);
  });

  test("treats reachable endpoint without target id as recoverable", async () => {
    const liveness = await probeChromeTargetLiveness({
      host: "127.0.0.1",
      port: 9222,
      verifyEndpoint: async () => ({ ok: true }),
      listTargets: async () => {
        throw new Error("should not list targets without targetId");
      },
    });
    expect(liveness).toEqual({ endpointReachable: true, targetFound: null });
    expect(isRecoverableChromeDisconnect(liveness)).toBe(true);
  });

  test("finds a still-live target id after client disconnect", async () => {
    const liveness = await probeChromeTargetLiveness({
      host: "127.0.0.1",
      port: 9222,
      targetId: "TARGET-1",
      verifyEndpoint: async () => ({ ok: true }),
      listTargets: async () => [
        { targetId: "TARGET-1", type: "page", url: "https://chatgpt.com/c/abc" },
      ],
    });
    expect(liveness).toEqual({
      endpointReachable: true,
      targetFound: true,
      matchedUrl: "https://chatgpt.com/c/abc",
    });
    expect(isRecoverableChromeDisconnect(liveness)).toBe(true);
  });

  test("marks missing target as non-recoverable when endpoint is up", async () => {
    const liveness = await probeChromeTargetLiveness({
      host: "127.0.0.1",
      port: 9222,
      targetId: "GONE",
      verifyEndpoint: async () => ({ ok: true }),
      listTargets: async () => [{ targetId: "OTHER", type: "page", url: "https://chatgpt.com/" }],
    });
    expect(liveness).toEqual({ endpointReachable: true, targetFound: false });
    expect(isRecoverableChromeDisconnect(liveness)).toBe(false);
  });

  test("fails closed when target list errors after a specific target id is requested", async () => {
    const liveness = await probeChromeTargetLiveness({
      host: "127.0.0.1",
      port: 9222,
      targetId: "TARGET-1",
      verifyEndpoint: async () => ({ ok: true }),
      listTargets: async () => {
        throw new Error("target list timeout");
      },
    });
    expect(liveness).toEqual({
      endpointReachable: true,
      targetFound: null,
      error: "target list timeout",
    });
    expect(isRecoverableChromeDisconnect(liveness)).toBe(false);
  });

  test("connectionLostUserMessage distinguishes recoverable disconnects", () => {
    expect(connectionLostUserMessage({ recoverable: true })).toContain("still alive");
    expect(connectionLostUserMessage({ recoverable: false })).toContain("Chrome window closed");
    expect(connectionLostUserMessage({ recoverable: true, remote: true })).toContain("Remote");
  });
});
