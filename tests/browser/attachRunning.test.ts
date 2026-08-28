import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserLogger } from "../../src/browser/types.js";

describe("resolveAttachRunningConnection", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("defaults attach-running discovery to 127.0.0.1:9222", async () => {
    vi.doMock("../../src/browser/detect.js", () => ({
      discoverDevToolsActivePortCandidates: vi.fn(async () => [
        {
          port: 9222,
          browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/default",
          path: "/profiles/default/DevToolsActivePort",
          profileRoot: "/profiles/default",
          mtimeMs: 10,
        },
      ]),
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn();

    const result = await resolveAttachRunningConnection(
      { chromePath: null, remoteChrome: undefined },
      logger,
    );

    expect(result).toMatchObject({
      host: "127.0.0.1",
      port: 9222,
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/default",
      profileRoot: "/profiles/default",
    });
    expect(logger).not.toHaveBeenCalledWith(
      expect.stringContaining("Waiting for Chrome remote debugging approval"),
    );
    expect(logger).toHaveBeenCalledWith(
      "Selected attach-running browser metadata from /profiles/default/DevToolsActivePort",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uses remote-chrome as the attach-running hint and prefers the newest candidate", async () => {
    vi.doMock("../../src/browser/detect.js", () => ({
      discoverDevToolsActivePortCandidates: vi.fn(async () => [
        {
          port: 63332,
          browserWSEndpoint: "ws://127.0.0.1:63332/devtools/browser/older",
          path: "/profiles/dia-older/DevToolsActivePort",
          profileRoot: "/profiles/dia-older",
          mtimeMs: 5,
        },
        {
          port: 63332,
          browserWSEndpoint: "ws://127.0.0.1:63332/devtools/browser/newer",
          path: "/profiles/dia-newer/DevToolsActivePort",
          profileRoot: "/profiles/dia-newer",
          mtimeMs: 20,
        },
      ]),
    }));

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn();

    const result = await resolveAttachRunningConnection(
      {
        chromePath: "/Applications/Dia.app/Contents/MacOS/Dia",
        remoteChrome: { host: "127.0.0.1", port: 63332 },
      },
      logger,
    );

    expect(result).toMatchObject({
      host: "127.0.0.1",
      port: 63332,
      browserWSEndpoint: "ws://127.0.0.1:63332/devtools/browser/newer",
      profileRoot: "/profiles/dia-newer",
    });
    expect(logger).toHaveBeenCalledWith(
      "Note: --browser-chrome-path is ignored when --browser-attach-running is enabled.",
    );
    expect(logger).toHaveBeenCalledWith(
      "Selected attach-running browser metadata from /profiles/dia-newer/DevToolsActivePort",
    );
  });

  test("probes the endpoint when DevToolsActivePort discovery finds nothing", async () => {
    vi.doMock("../../src/browser/detect.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/browser/detect.js")>()),
      discoverDevToolsActivePortCandidates: vi.fn(async () => []),
    }));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          webSocketDebuggerUrl: "ws://127.0.0.1:63332/devtools/browser/probed",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn() as BrowserLogger;

    const result = await resolveAttachRunningConnection(
      {
        chromePath: null,
        remoteChrome: { host: "127.0.0.1", port: 63332 },
      },
      logger,
    );

    expect(result).toEqual({
      host: "127.0.0.1",
      port: 63332,
      browserWSEndpoint: "ws://127.0.0.1:63332/devtools/browser/probed",
      profileRoot: null,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:63332/json/version", {
      signal: expect.any(AbortSignal),
    });
  });

  test("brackets an IPv6 host when probing the endpoint", async () => {
    vi.doMock("../../src/browser/detect.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/browser/detect.js")>()),
      discoverDevToolsActivePortCandidates: vi.fn(async () => []),
    }));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          webSocketDebuggerUrl: "ws://[::1]:9222/devtools/browser/probed",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn() as BrowserLogger;

    const result = await resolveAttachRunningConnection(
      {
        chromePath: null,
        remoteChrome: { host: "::1", port: 9222 },
      },
      logger,
    );

    expect(result).toEqual({
      host: "::1",
      port: 9222,
      browserWSEndpoint: "ws://[::1]:9222/devtools/browser/probed",
      profileRoot: null,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://[::1]:9222/json/version", {
      signal: expect.any(AbortSignal),
    });
    const [versionUrl] = fetchMock.mock.calls[0] as [string];
    expect(() => new URL(versionUrl)).not.toThrow();
  });

  test("keeps an IPv4 host unchanged when probing the endpoint", async () => {
    vi.doMock("../../src/browser/detect.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/browser/detect.js")>()),
      discoverDevToolsActivePortCandidates: vi.fn(async () => []),
    }));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/probed",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn() as BrowserLogger;

    const result = await resolveAttachRunningConnection(
      {
        chromePath: null,
        remoteChrome: { host: "127.0.0.1", port: 9222 },
      },
      logger,
    );

    expect(result).toEqual({
      host: "127.0.0.1",
      port: 9222,
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/probed",
      profileRoot: null,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:9222/json/version", {
      signal: expect.any(AbortSignal),
    });
  });

  test("reports discovery roots and a failed endpoint probe", async () => {
    vi.doMock("../../src/browser/detect.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/browser/detect.js")>()),
      discoverDevToolsActivePortCandidates: vi.fn(async () => []),
      resolveDevToolsActivePortDiscoveryRoots: vi.fn(() => ["/profiles/search-root"]),
    }));
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resolveAttachRunningConnection(
        {
          chromePath: null,
          remoteChrome: { host: "127.0.0.1", port: 63332 },
        },
        logger,
      ),
    ).rejects.toThrow(
      /DevToolsActivePort discovery searched \/profiles\/search-root, and endpoint probe http:\/\/127\.0\.0\.1:63332\/json\/version failed: connection refused/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("clears the abort timer after every rejected endpoint probe", async () => {
    vi.doMock("../../src/browser/detect.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/browser/detect.js")>()),
      discoverDevToolsActivePortCandidates: vi.fn(async () => []),
      resolveDevToolsActivePortDiscoveryRoots: vi.fn(() => ["/profiles/search-root"]),
    }));
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    try {
      const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
      const logger = vi.fn() as BrowserLogger;

      await expect(
        resolveAttachRunningConnection(
          {
            chromePath: null,
            remoteChrome: { host: "127.0.0.1", port: 9222 },
          },
          logger,
        ),
      ).rejects.toThrow(/endpoint probe .* failed: connection refused/i);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });
});
