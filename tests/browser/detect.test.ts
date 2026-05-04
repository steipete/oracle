import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  discoverDevToolsActivePortCandidates,
  inferAttachRunningBrowserFamily,
  parseDevToolsActivePort,
  resolveAttachRunningProfileRoots,
} from "../../src/browser/detect.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("attach-running browser detection", () => {
  test("parses DevToolsActivePort into a browser websocket endpoint", () => {
    expect(
      parseDevToolsActivePort("9222\n/devtools/browser/abc123\n", { host: "127.0.0.1" }),
    ).toEqual({
      port: 9222,
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc123",
    });
  });

  test("wraps IPv6 hosts when building browser websocket endpoints", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/abc123\n", { host: "::1" })).toEqual({
      port: 9222,
      browserWSEndpoint: "ws://[::1]:9222/devtools/browser/abc123",
    });
  });

  test("infers supported browser family from browser-chrome-path", () => {
    expect(
      inferAttachRunningBrowserFamily(
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ),
    ).toBe("edge");
    expect(
      inferAttachRunningBrowserFamily(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
    ).toBe("chrome");
  });

  test("orders attach-running browser roots by preferred browser family", () => {
    const roots = resolveAttachRunningProfileRoots("darwin", "/Users/peter");

    expect(roots.map((entry) => entry.family)).toEqual(["chrome", "chromium", "edge", "brave"]);
    expect(roots[0]?.root.split(path.sep).join("/")).toContain("Google/Chrome");
  });

  test("discovers DevToolsActivePort files recursively and derives profile roots", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-detect-"));
    tempDirs.push(homeDir);
    const defaultDir = path.join(
      homeDir,
      "Library",
      "Application Support",
      "Dia",
      "User Data",
      "Default",
    );
    await fs.mkdir(defaultDir, { recursive: true });
    await fs.writeFile(
      path.join(defaultDir, "DevToolsActivePort"),
      "63332\n/devtools/browser/dia\n",
      "utf8",
    );

    const candidates = await discoverDevToolsActivePortCandidates({
      host: "127.0.0.1",
      platform: "darwin",
      homeDir,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      port: 63332,
      browserWSEndpoint: "ws://127.0.0.1:63332/devtools/browser/dia",
      profileRoot: path.join(homeDir, "Library", "Application Support", "Dia", "User Data"),
    });
  });
});
