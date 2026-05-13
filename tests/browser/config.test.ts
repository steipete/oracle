import { afterEach, describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CHATGPT_COOKIE_NAMES, resolveBrowserConfig } from "../../src/browser/config.js";
import { CHATGPT_URL, DEEP_RESEARCH_DEFAULT_TIMEOUT_MS } from "../../src/browser/constants.js";

describe("resolveBrowserConfig", () => {
  const originalProfileDir = process.env.ORACLE_BROWSER_PROFILE_DIR;
  const originalBrowserPort = process.env.ORACLE_BROWSER_PORT;
  const originalBrowserDebugPort = process.env.ORACLE_BROWSER_DEBUG_PORT;

  afterEach(() => {
    if (originalProfileDir === undefined) {
      delete process.env.ORACLE_BROWSER_PROFILE_DIR;
    } else {
      process.env.ORACLE_BROWSER_PROFILE_DIR = originalProfileDir;
    }
    if (originalBrowserPort === undefined) {
      delete process.env.ORACLE_BROWSER_PORT;
    } else {
      process.env.ORACLE_BROWSER_PORT = originalBrowserPort;
    }
    if (originalBrowserDebugPort === undefined) {
      delete process.env.ORACLE_BROWSER_DEBUG_PORT;
    } else {
      process.env.ORACLE_BROWSER_DEBUG_PORT = originalBrowserDebugPort;
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
    expect(resolved.archiveConversations).toBe("auto");
  });

  test("applies overrides", () => {
    const resolved = resolveBrowserConfig({
      url: "https://chatgpt.com/g/g-p-foo/project",
      timeoutMs: 123,
      inputTimeoutMs: 456,
      cookieSync: false,
      headless: true,
      desiredModel: "Custom",
      chromeProfile: "Profile 1",
      chromePath: "/Applications/Chrome",
      browserTabRef: "current",
      debug: true,
      maxConcurrentTabs: 5,
      researchMode: "deep",
      archiveConversations: "never",
    });
    expect(resolved.url).toBe("https://chatgpt.com/g/g-p-foo/project");
    expect(resolved.timeoutMs).toBe(123);
    expect(resolved.inputTimeoutMs).toBe(456);
    expect(resolved.cookieSync).toBe(false);
    expect(resolved.headless).toBe(true);
    expect(resolved.desiredModel).toBe("Custom");
    expect(resolved.chromeProfile).toBe("Profile 1");
    expect(resolved.chromePath).toBe("/Applications/Chrome");
    expect(resolved.browserTabRef).toBe("current");
    expect(resolved.debug).toBe(true);
    expect(resolved.maxConcurrentTabs).toBe(5);
    expect(resolved.researchMode).toBe("deep");
    expect(resolved.archiveConversations).toBe("never");
  });

  test("allows temporary chat URLs when desiredModel is Pro", () => {
    const resolved = resolveBrowserConfig({
      url: "https://chatgpt.com/?temporary-chat=true",
      desiredModel: "GPT-5.2 Pro",
    });

    expect(resolved.url).toBe("https://chatgpt.com/?temporary-chat=true");
    expect(resolved.desiredModel).toBe("GPT-5.2 Pro");
    expect(resolved.modelStrategy).toBe("select");
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

  test("uses the longer Deep Research timeout unless explicitly overridden", () => {
    expect(resolveBrowserConfig({ researchMode: "deep" }).timeoutMs).toBe(
      DEEP_RESEARCH_DEFAULT_TIMEOUT_MS,
    );
    expect(resolveBrowserConfig({ researchMode: "deep", timeoutMs: 123 }).timeoutMs).toBe(123);
  });

  test("does not truncate non-numeric browser port env values", () => {
    delete process.env.ORACLE_BROWSER_DEBUG_PORT;

    process.env.ORACLE_BROWSER_PORT = " 9222 ";
    expect(resolveBrowserConfig(undefined).debugPort).toBe(9_222);

    process.env.ORACLE_BROWSER_PORT = "9222abc";
    expect(resolveBrowserConfig(undefined).debugPort).toBeNull();
  });

  test("normalizes cookie names back to the safe allowlist when input is empty or invalid", () => {
    expect(resolveBrowserConfig({ cookieNames: [] }).cookieNames).toEqual(
      DEFAULT_CHATGPT_COOKIE_NAMES,
    );
    expect(
      resolveBrowserConfig({
        cookieNames: [" __Secure-next-auth.session-token ", "bad\r\nInjected: x", "semi;colon"],
      }).cookieNames,
    ).toEqual(["__Secure-next-auth.session-token"]);
  });

  test("rejects non-ChatGPT browser URLs before they can receive cookies", () => {
    expect(() => resolveBrowserConfig({ url: "https://example.com/" })).toThrow(
      /ChatGPT URL host/i,
    );
  });
});
