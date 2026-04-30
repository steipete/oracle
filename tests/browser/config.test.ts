import { afterEach, describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CHATGPT_COOKIE_NAMES, resolveBrowserConfig } from "../../src/browser/config.js";
import { CHATGPT_URL } from "../../src/browser/constants.js";

describe("resolveBrowserConfig", () => {
  const originalProfileDir = process.env.ORACLE_BROWSER_PROFILE_DIR;

  afterEach(() => {
    if (originalProfileDir === undefined) {
      delete process.env.ORACLE_BROWSER_PROFILE_DIR;
    } else {
      process.env.ORACLE_BROWSER_PROFILE_DIR = originalProfileDir;
    }
  });

  test("returns defaults when config missing", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.url).toBe(CHATGPT_URL);
    const isWindows = process.platform === "win32";
    expect(resolved.cookieSync).toBe(!isWindows);
    expect(resolved.cookieNames).toEqual(DEFAULT_CHATGPT_COOKIE_NAMES);
    expect(resolved.headless).toBe(false);
    expect(resolved.manualLogin).toBe(isWindows);
    expect(resolved.profileLockTimeoutMs).toBe(300_000);
    expect(resolved.maxConcurrentTabs).toBe(3);
    expect(resolved.researchMode).toBe("off");
  });

  test("applies overrides", () => {
    const resolved = resolveBrowserConfig({
      url: "https://example.com",
      timeoutMs: 123,
      inputTimeoutMs: 456,
      cookieSync: false,
      headless: true,
      desiredModel: "Custom",
      chromeProfile: "Profile 1",
      chromePath: "/Applications/Chrome",
      debug: true,
      maxConcurrentTabs: 5,
      researchMode: "deep",
    });
    expect(resolved.url).toBe("https://example.com/");
    expect(resolved.timeoutMs).toBe(123);
    expect(resolved.inputTimeoutMs).toBe(456);
    expect(resolved.cookieSync).toBe(false);
    expect(resolved.headless).toBe(true);
    expect(resolved.desiredModel).toBe("Custom");
    expect(resolved.chromeProfile).toBe("Profile 1");
    expect(resolved.chromePath).toBe("/Applications/Chrome");
    expect(resolved.debug).toBe(true);
    expect(resolved.maxConcurrentTabs).toBe(5);
    expect(resolved.researchMode).toBe("deep");
  });

  test("rejects temporary chat URLs when desiredModel is Pro", () => {
    expect(() =>
      resolveBrowserConfig({
        url: "https://chatgpt.com/?temporary-chat=true",
        desiredModel: "GPT-5.2 Pro",
      }),
    ).toThrow(/Temporary Chat/i);
  });

  test("resolves manual-login profile dirs from config, env, and default", () => {
    process.env.ORACLE_BROWSER_PROFILE_DIR = "/tmp/env-profile";

    expect(
      resolveBrowserConfig({
        manualLogin: true,
        manualLoginProfileDir: " /tmp/config-profile ",
      }).manualLoginProfileDir,
    ).toBe("/tmp/config-profile");

    expect(resolveBrowserConfig({ manualLogin: true }).manualLoginProfileDir).toBe(
      "/tmp/env-profile",
    );

    process.env.ORACLE_BROWSER_PROFILE_DIR = "   ";
    expect(resolveBrowserConfig({ manualLogin: true }).manualLoginProfileDir).toBe(
      path.join(os.homedir(), ".oracle", "browser-profile"),
    );

    expect(resolveBrowserConfig({ manualLogin: false }).manualLoginProfileDir).toBeNull();
  });
});
