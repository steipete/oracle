import { describe, expect, test, vi } from "vitest";
import { buildBrowserConfig, resolveBrowserModelLabel } from "../../src/cli/browserConfig.js";

describe("buildBrowserConfig", () => {
  test("uses defaults when optional flags omitted", async () => {
    const config = await buildBrowserConfig({ model: "gpt-5.5-pro" });
    expect(config).toMatchObject({
      chromeProfile: "Default",
      chromePath: null,
      chromeCookiePath: null,
      url: undefined,
      timeoutMs: undefined,
      inputTimeoutMs: undefined,
      cookieSync: undefined,
      headless: undefined,
      keepBrowser: undefined,
      hideWindow: undefined,
      desiredModel: "GPT-5.5",
      thinkingTime: "pro",
      debug: undefined,
      allowCookieErrors: true,
      researchMode: "off",
      archiveConversations: undefined,
    });
  });

  test("forwards configured manual-login cookie sync to browser sessions", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.5-pro",
      browserManualLogin: true,
      browserManualLoginCookieSync: true,
    });

    expect(config.manualLoginCookieSync).toBe(true);
  });

  test("maps gpt-5.4 browser runs to Thinking 5.4", async () => {
    const config = await buildBrowserConfig({ model: "gpt-5.4" });
    expect(config.desiredModel).toBe("Thinking 5.4");
  });

  test("maps the GPT-5.6 family and explicit Sol variant separately", async () => {
    const config = await buildBrowserConfig({ model: "gpt-5.6" });
    expect(config.desiredModel).toBe("GPT-5.6 Sol");
    const sol = await buildBrowserConfig({ model: "gpt-5.6-sol" });
    expect(sol.desiredModel).toBe("GPT-5.6 Sol");
  });

  test("keeps version signal for gpt-5.5 Instant browser runs", async () => {
    const config = await buildBrowserConfig({ model: "gpt-5.5-instant" });
    expect(config.desiredModel).toBe("GPT-5.5 Instant");
  });

  test.each(["gpt-5.2", "gpt-5.2-instant", "gpt-5.2-thinking", "gpt-5.1"])(
    "rejects retired browser model alias %s before launching Chrome",
    async (model) => {
      await expect(buildBrowserConfig({ model })).rejects.toThrow(
        /ChatGPT no longer offers GPT-5\.2 base, Instant, or Thinking/,
      );
    },
  );

  test.each(["gpt-5-pro", "gpt-5.1-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"])(
    "maps Pro browser alias %s to GPT-5.5 with Pro effort",
    async (model) => {
      await expect(buildBrowserConfig({ model })).resolves.toMatchObject({
        desiredModel: "GPT-5.5",
        thinkingTime: "pro",
      });
    },
  );

  test("lets an explicit effort override the Pro alias default", async () => {
    await expect(
      buildBrowserConfig({ model: "gpt-5.2-pro", browserThinkingTime: "extended" }),
    ).resolves.toMatchObject({
      desiredModel: "GPT-5.5",
      thinkingTime: "extended",
    });
  });

  test("keeps current-model selection available for retired base aliases", async () => {
    await expect(
      buildBrowserConfig({ model: "gpt-5.2", browserModelStrategy: "current" }),
    ).resolves.toMatchObject({ modelStrategy: "current" });
  });

  test("sets model strategy when provided", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      browserModelStrategy: "current",
    });
    expect(config.modelStrategy).toBe("current");
    expect(config.thinkingTime).toBeUndefined();
  });

  test("maps --copy-profile to copyProfileSource", async () => {
    const source = "/Users/me/Library/Application Support/Google/Chrome";
    const config = await buildBrowserConfig({ model: "gpt-5.5-pro", copyProfile: source });
    expect(config.copyProfileSource).toBe(source);
    expect(config.chromeProfile).toBeNull();
    const selected = await buildBrowserConfig({
      model: "gpt-5.5-pro",
      copyProfile: source,
      browserChromeProfile: "Profile 4",
    });
    expect(selected.chromeProfile).toBe("Profile 4");
  });

  test("leaves copyProfileSource undefined without --copy-profile", async () => {
    const config = await buildBrowserConfig({ model: "gpt-5.5-pro" });
    expect(config.copyProfileSource).toBeUndefined();
  });

  test("rejects --copy-profile combined with --browser-keep-browser", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.5-pro",
        copyProfile: "/Users/me/Library/Application Support/Google/Chrome",
        browserKeepBrowser: true,
      }),
    ).rejects.toThrow(/--copy-profile cannot be combined with --browser-keep-browser/);
  });

  test("rejects --copy-profile combined with --browser-manual-login", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.5-pro",
        copyProfile: "/Users/me/Library/Application Support/Google/Chrome",
        browserManualLogin: true,
      }),
    ).rejects.toThrow(/--copy-profile cannot be combined with --browser-manual-login/);
  });

  test("rejects --copy-profile combined with existing or remote browser modes", async () => {
    const source = "/Users/me/Library/Application Support/Google/Chrome";
    await expect(
      buildBrowserConfig({
        model: "gpt-5.5-pro",
        copyProfile: source,
        browserAttachRunning: true,
      }),
    ).rejects.toThrow(/browser-attach-running cannot be combined with --copy-profile/);
    await expect(
      buildBrowserConfig({
        model: "gpt-5.5-pro",
        copyProfile: source,
        remoteChrome: "127.0.0.1:9222",
      }),
    ).rejects.toThrow(/copy-profile cannot be combined with --remote-chrome/);
    await expect(
      buildBrowserConfig({
        model: "gpt-5.5-pro",
        copyProfile: source,
        remoteHost: "browser.example:9473",
      }),
    ).rejects.toThrow(/copy-profile cannot be combined with --remote-host/);
  });

  test("enables Deep Research browser mode when requested", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.4-pro",
      browserResearch: "deep",
    });
    expect(config.researchMode).toBe("deep");
  });

  test("sets browser archive mode when requested", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.4-pro",
      browserArchive: "never",
    });
    expect(config.archiveConversations).toBe("never");
  });

  test("honors overrides and converts durations + booleans", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.4",
      browserChromeProfile: "Profile 2",
      browserChromePath: "/Applications/Chrome.app",
      browserCookiePath: "/tmp/cookies.db",
      browserUrl: "https://chat.example.com",
      browserTimeout: "120s",
      browserInputTimeout: "5s",
      browserAttachmentTimeout: "2m",
      browserProfileLockTimeout: "2m",
      browserMaxConcurrentTabs: "5",
      browserCookieWait: "4s",
      browserNoCookieSync: true,
      browserHeadless: true,
      browserHideWindow: true,
      browserKeepBrowser: true,
      browserAllowCookieErrors: true,
      verbose: true,
    });
    expect(config).toMatchObject({
      chromeProfile: "Profile 2",
      chromePath: "/Applications/Chrome.app",
      chromeCookiePath: "/tmp/cookies.db",
      url: "https://chat.example.com/",
      timeoutMs: 120_000,
      inputTimeoutMs: 5_000,
      attachmentTimeoutMs: 120_000,
      profileLockTimeoutMs: 120_000,
      maxConcurrentTabs: 5,
      cookieSyncWaitMs: 4_000,
      cookieSync: false,
      headless: undefined,
      hideWindow: true,
      keepBrowser: true,
      desiredModel: "Thinking 5.4",
      debug: true,
      allowCookieErrors: true,
    });
  });

  test("accepts a valid explicit browser duration without a warning", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const config = await buildBrowserConfig({
      model: "gpt-5.5-pro",
      browserTimeout: "1h30m",
    });

    expect(config.timeoutMs).toBe(5_400_000);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test("warns and uses the fallback for a malformed explicit browser duration", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const config = await buildBrowserConfig({
      model: "gpt-5.5-pro",
      browserTimeout: "1h!30m",
    });

    expect(config.timeoutMs).toBe(1_200_000);
    expect(logSpy).toHaveBeenCalledWith(
      'Warning: invalid --browser-timeout duration "1h!30m"; using fallback 1200000ms.',
    );
    logSpy.mockRestore();
  });

  test("warns and uses the zero fallback for a malformed browser-recheck-delay duration", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const config = await buildBrowserConfig({
      model: "gpt-5.5-pro",
      browserRecheckDelay: "zzz",
    });

    expect(config.assistantRecheckDelayMs).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      'Warning: invalid --browser-recheck-delay duration "zzz"; using fallback 0ms.',
    );
    logSpy.mockRestore();
  });

  test("warns and uses the fallback for a malformed browser-auto-reattach-timeout duration", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const config = await buildBrowserConfig({
      model: "gpt-5.5-pro",
      browserAutoReattachTimeout: "zzz",
    });

    expect(config.autoReattachTimeoutMs).toBe(120_000);
    expect(logSpy).toHaveBeenCalledWith(
      'Warning: invalid --browser-auto-reattach-timeout duration "zzz"; using fallback 120000ms.',
    );
    logSpy.mockRestore();
  });

  test("warns independently for each malformed duration when several are supplied together", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const config = await buildBrowserConfig({
      model: "gpt-5.5-pro",
      browserInputTimeout: "zzz",
      browserReuseWait: "zzz",
      browserAutoReattachInterval: "zzz",
    });

    expect(config.inputTimeoutMs).toBe(60_000);
    expect(config.reuseChromeWaitMs).toBe(0);
    expect(config.autoReattachIntervalMs).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      'Warning: invalid --browser-input-timeout duration "zzz"; using fallback 60000ms.',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Warning: invalid --browser-reuse-wait duration "zzz"; using fallback 0ms.',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Warning: invalid --browser-auto-reattach-interval duration "zzz"; using fallback 0ms.',
    );
    expect(logSpy).toHaveBeenCalledTimes(3);
    logSpy.mockRestore();
  });

  test("prefers explicit browser model label when provided", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      browserModelLabel: "Instant",
    });
    expect(config.desiredModel).toBe("GPT-5.5");
  });

  test("rejects invalid browser max concurrent tabs", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.4",
        browserMaxConcurrentTabs: "0",
      }),
    ).rejects.toThrow(/max concurrent tabs/i);
  });

  test("falls back to canonical label when override matches base model", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.4",
      browserModelLabel: "gpt-5.4",
    });
    expect(config.desiredModel).toBe("Thinking 5.4");
  });

  test("maps legacy Gemini Pro to current Pro label", async () => {
    const config = await buildBrowserConfig({
      model: "gemini-3-pro",
    });
    expect(config.desiredModel).toBe("Gemini 3.1 Pro");
  });

  test.each([
    ["gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite"],
    ["gemini-3.5-flash", "Gemini 3.5 Flash"],
    ["gemini-3.1-pro", "Gemini 3.1 Pro"],
  ])("maps current Gemini model %s to %s", async (model, expected) => {
    const config = await buildBrowserConfig({ model });
    expect(config.desiredModel).toBe(expected);
  });

  test("maps deep-think Gemini model to deep-think label", async () => {
    const config = await buildBrowserConfig({
      model: "gemini-3-pro-deep-think",
    });
    expect(config.desiredModel).toBe("gemini-3-deep-think");
  });

  test("trims whitespace around override labels", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.4",
      browserModelLabel: "  ChatGPT 5.4 Thinking  ",
    });
    expect(config.desiredModel).toBe("Thinking 5.4");
  });

  test("parses remoteChrome host targets", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      remoteChrome: "remote-host:9333",
    });
    expect(config.remoteChrome).toEqual({ host: "remote-host", port: 9_333 });
  });

  test("enables attach-running with auto-connect by default", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      browserAttachRunning: true,
    });
    expect(config.attachRunning).toBe(true);
  });

  test("passes through a browser tab ref", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      browserTab: "current",
    });
    expect(config.browserTabRef).toBe("current");
  });

  test("still accepts browser-chrome-path when attach-running is enabled", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      browserAttachRunning: true,
      browserChromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    expect(config.attachRunning).toBe(true);
    expect(config.chromePath).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  test("rejects launcher-owned flags when attach-running is enabled", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.2-pro",
        browserAttachRunning: true,
        browserManualLogin: true,
      }),
    ).rejects.toThrow(/attach-running/i);
  });

  test("rejects browser-chrome-profile when attach-running is enabled", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.2-pro",
        browserAttachRunning: true,
        browserChromeProfile: "Profile 2",
      }),
    ).rejects.toThrow(/attach-running/i);
  });

  test("rejects browser-manual-login-profile-dir when attach-running is enabled", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.2-pro",
        browserAttachRunning: true,
        browserManualLoginProfileDir: "/tmp/oracle-profile",
      }),
    ).rejects.toThrow(/attach-running/i);
  });

  test("rejects inline cookie overrides when attach-running is enabled", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.2-pro",
        browserAttachRunning: true,
        browserInlineCookies: "[]",
      }),
    ).rejects.toThrow(/attach-running/i);
  });

  test("allows remote-chrome as an attach-running hint", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      browserAttachRunning: true,
      remoteChrome: "remote-host:9333",
    });
    expect(config.attachRunning).toBe(true);
    expect(config.remoteChrome).toEqual({ host: "remote-host", port: 9_333 });
  });

  test("normalizes chatgpt-url alias and adds https when missing", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.4",
      chatgptUrl: "chatgpt.example.com/workspace",
    });
    expect(config.url).toBe("https://chatgpt.example.com/workspace");
  });

  test("rejects invalid chatgpt URL protocols", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.4",
        chatgptUrl: "ftp://chatgpt.example.com",
      }),
    ).rejects.toThrow(/http/i);
  });

  test("allows temporary chat URLs when targeting Pro", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.5-pro",
      chatgptUrl: "https://chatgpt.com/?temporary-chat=true",
    });
    expect(config.url).toBe("https://chatgpt.com/?temporary-chat=true");
    expect(config.desiredModel).toBe("GPT-5.5");
    expect(config.modelStrategy).toBe("select");
  });

  test("allows temporary chat URLs when model strategy keeps current selection", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      chatgptUrl: "https://chatgpt.com/?temporary-chat=true",
      browserModelStrategy: "current",
    });
    expect(config.url).toBe("https://chatgpt.com/?temporary-chat=true");
    expect(config.modelStrategy).toBe("current");
  });

  test("allows temporary chat URLs when not targeting Pro", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.4",
      chatgptUrl: "https://chatgpt.com/?temporary-chat=true",
    });
    expect(config.url).toBe("https://chatgpt.com/?temporary-chat=true");
    expect(config.desiredModel).toBe("Thinking 5.4");
  });

  test("accepts IPv6 remoteChrome targets wrapped in brackets", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-5.2-pro",
      remoteChrome: "[2001:db8::1]:9222",
    });
    expect(config.remoteChrome).toEqual({ host: "2001:db8::1", port: 9_222 });
  });

  test("rejects malformed remoteChrome targets", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.2-pro",
        remoteChrome: "just-a-host",
      }),
    ).rejects.toThrow(/host:port/i);
  });

  test("rejects remoteChrome IPv6 without brackets", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.2-pro",
        remoteChrome: "2001:db8::1:9222",
      }),
    ).rejects.toThrow(/Wrap IPv6 addresses/i);
  });

  test("rejects out-of-range remoteChrome ports", async () => {
    await expect(
      buildBrowserConfig({
        model: "gpt-5.2-pro",
        remoteChrome: "server:70000",
      }),
    ).rejects.toThrow(/between 1 and 65535/i);
  });
});

describe("resolveBrowserModelLabel", () => {
  test("returns canonical ChatGPT label when CLI value matches API model", () => {
    expect(resolveBrowserModelLabel("gpt-5.5-pro", "gpt-5.5-pro")).toBe("GPT-5.5");
    expect(resolveBrowserModelLabel("gpt-5.5-instant", "gpt-5.5-instant")).toBe("GPT-5.5 Instant");
    expect(resolveBrowserModelLabel("gpt-5.5", "gpt-5.5")).toBe("Thinking 5.5");
    expect(resolveBrowserModelLabel("gpt-5.4-pro", "gpt-5.4-pro")).toBe("GPT-5.5");
    expect(resolveBrowserModelLabel("gpt-5.4", "gpt-5.4")).toBe("Thinking 5.4");
    expect(resolveBrowserModelLabel("gpt-5-pro", "gpt-5-pro")).toBe("GPT-5.5");
    expect(resolveBrowserModelLabel("gpt-5.2-pro", "gpt-5.2-pro")).toBe("GPT-5.5");
    expect(resolveBrowserModelLabel("gpt-5.1-pro", "gpt-5.1-pro")).toBe("GPT-5.5");
    expect(resolveBrowserModelLabel("GPT-5.1", "gpt-5.1")).toBe("GPT-5.2");
  });

  test("falls back to canonical label when input is empty", () => {
    expect(resolveBrowserModelLabel("", "gpt-5.1")).toBe("GPT-5.2");
  });

  test("preserves descriptive labels to target alternate picker entries", () => {
    expect(resolveBrowserModelLabel("ChatGPT 5.1 Instant", "gpt-5.1")).toBe("ChatGPT 5.1 Instant");
  });

  test("supports undefined or whitespace-only input", () => {
    expect(resolveBrowserModelLabel(undefined, "gpt-5.2-pro")).toBe("GPT-5.5");
    expect(resolveBrowserModelLabel("   ", "gpt-5.1")).toBe("GPT-5.2");
  });

  test("trims descriptive labels before returning them", () => {
    expect(resolveBrowserModelLabel("  ChatGPT 5.1 Thinking ", "gpt-5.1")).toBe(
      "ChatGPT 5.1 Thinking",
    );
  });
});
