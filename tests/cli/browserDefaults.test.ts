import { describe, expect, test } from "vitest";
import { Command, Option } from "commander";
import {
  applyBrowserDefaultsFromConfig,
  type BrowserDefaultsOptions,
} from "../../src/cli/browserDefaults.js";
import type { UserConfig } from "../../src/config.js";

const source = (_key: keyof BrowserDefaultsOptions) => undefined;

describe("applyBrowserDefaultsFromConfig", () => {
  test("uses the same configured remote Chrome as MCP unless CLI overrides it", () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = { browser: { remoteChrome: { host: "127.0.0.1", port: 9222 } } };
    applyBrowserDefaultsFromConfig(options, config, source);
    expect(options.remoteChrome).toBe("127.0.0.1:9222");
    options.remoteChrome = "another-host:9444";
    applyBrowserDefaultsFromConfig(options, config, () => "cli");
    expect(options.remoteChrome).toBe("another-host:9444");
  });

  test("formats IPv6 remote Chrome defaults for the existing target parser", () => {
    for (const host of ["::1", "[::1]"]) {
      const options: BrowserDefaultsOptions = {};
      applyBrowserDefaultsFromConfig(
        options,
        { browser: { remoteChrome: { host, port: 9222 } } },
        source,
      );
      expect(options.remoteChrome).toBe("[::1]:9222");
    }
  });

  test("uses the configured host/port and respects non-CLI endpoint overrides", () => {
    const config: UserConfig = {
      browser: { remoteChrome: { host: "devbox.example", port: 9444 } },
    };
    const options: BrowserDefaultsOptions = {};
    applyBrowserDefaultsFromConfig(options, config, source);
    expect(options.remoteChrome).toBe("devbox.example:9444");
    options.remoteChrome = "programmatic.example:9555";
    applyBrowserDefaultsFromConfig(options, config, source);
    expect(options.remoteChrome).toBe("programmatic.example:9555");
  });

  test("respects configured attach-running unless the CLI explicitly turns it off", () => {
    const config: UserConfig = {
      browser: { attachRunning: true, remoteChrome: { host: "remote.example", port: 9444 } },
    };
    const inherited: BrowserDefaultsOptions = {};
    applyBrowserDefaultsFromConfig(inherited, config, source);
    expect(inherited.remoteChrome).toBeUndefined();
    const explicit: BrowserDefaultsOptions = { browserAttachRunning: false };
    applyBrowserDefaultsFromConfig(explicit, config, (key) =>
      key === "browserAttachRunning" ? "cli" : undefined,
    );
    expect(explicit.remoteChrome).toBe("remote.example:9444");
  });

  test("preserves explicit attach-running and copy-profile connection choices", () => {
    for (const options of [
      { browserAttachRunning: true },
      { copyProfile: "/profile" },
    ] as BrowserDefaultsOptions[]) {
      applyBrowserDefaultsFromConfig(
        options,
        { browser: { remoteChrome: { host: "127.0.0.1", port: 9222 } } },
        source,
      );
      expect(options.remoteChrome).toBeUndefined();
    }
  });

  test("leaves an unset or null remote Chrome configuration local", () => {
    for (const config of [{}, { browser: { remoteChrome: null } }]) {
      const options: BrowserDefaultsOptions = {};
      applyBrowserDefaultsFromConfig(options, config, source);
      expect(options.remoteChrome).toBeUndefined();
    }
  });
  test("applies chatgptUrl from user config when flags are absent", () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        chatgptUrl: "https://chatgpt.com/g/g-p-foo/project",
      },
    };

    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.chatgptUrl).toBe("https://chatgpt.com/g/g-p-foo/project");
  });

  test("does not override when CLI provided chatgptUrl", () => {
    const options: BrowserDefaultsOptions = { chatgptUrl: "https://override.example.com/" };
    const config: UserConfig = {
      browser: {
        chatgptUrl: "https://chatgpt.com/g/g-p-foo/project",
      },
    };

    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.chatgptUrl).toBe("https://override.example.com/");
  });

  test("falls back to browser.url when chatgptUrl missing", () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        url: "https://chatgpt.com/g/g-p-bar/project",
      },
    };

    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.chatgptUrl).toBe("https://chatgpt.com/g/g-p-bar/project");
  });

  test("applies chrome defaults when CLI flags are untouched or defaulted", () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        chromePath: "/Applications/Comet.app/Contents/MacOS/Comet",
        chromeProfile: "Work",
        chromeCookiePath: "/tmp/cookies",
        timeoutMs: 120_000,
        inputTimeoutMs: 15_000,
        attachmentTimeoutMs: 90_000,
        profileLockTimeoutMs: 90_000,
        maxConcurrentTabs: 4,
        cookieSync: true,
        cookieSyncWaitMs: 4_000,
        headless: true,
        hideWindow: true,
        keepBrowser: true,
      },
    };

    applyBrowserDefaultsFromConfig(options, config, (_key) => "default");

    expect(options.browserChromePath).toBe("/Applications/Comet.app/Contents/MacOS/Comet");
    expect(options.browserChromeProfile).toBe("Work");
    expect(options.browserCookiePath).toBe("/tmp/cookies");
    expect(options.browserTimeout).toBe("120000");
    expect(options.browserInputTimeout).toBe("15000");
    expect(options.browserAttachmentTimeout).toBe("90000");
    expect(options.browserProfileLockTimeout).toBe("90000");
    expect(options.browserMaxConcurrentTabs).toBe("4");
    expect(options.browserCookieWait).toBe("4000");
    expect(options.browserCookieSync).toBe(true);
    expect(options.browserHeadless).toBe(true);
    expect(options.browserHideWindow).toBe(true);
    expect(options.browserKeepBrowser).toBe(true);
  });

  test("applies thinking time when CLI flag is untouched", () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        thinkingTime: "extended",
      },
    };

    applyBrowserDefaultsFromConfig(options, config, (_key) => "default");

    expect(options.browserThinkingTime).toBe("extended");
  });

  test("applies browser research mode when CLI flag is untouched", () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        researchMode: "deep",
      },
    };

    applyBrowserDefaultsFromConfig(options, config, (_key) => "default");

    expect(options.browserResearch).toBe("deep");
  });

  test("does not override thinking time when CLI provided a value", () => {
    const options: BrowserDefaultsOptions = { browserThinkingTime: "light" };
    const config: UserConfig = {
      browser: {
        thinkingTime: "heavy",
      },
    };

    const source = (key: keyof BrowserDefaultsOptions) =>
      key === "browserThinkingTime" ? "cli" : "default";
    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.browserThinkingTime).toBe("light");
  });

  test("does not inherit thinking time when CLI requests the current model", () => {
    const options: BrowserDefaultsOptions = { browserModelStrategy: "current" };
    const config: UserConfig = {
      browser: {
        thinkingTime: "extended",
      },
    };

    const source = (key: keyof BrowserDefaultsOptions) =>
      key === "browserModelStrategy" ? "cli" : "default";
    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.browserThinkingTime).toBeUndefined();
  });

  test("keeps explicit thinking time when CLI requests the current model", () => {
    const options: BrowserDefaultsOptions = {
      browserModelStrategy: "current",
      browserThinkingTime: "extended",
    };
    const config: UserConfig = {
      browser: {
        thinkingTime: "heavy",
      },
    };

    const source = (key: keyof BrowserDefaultsOptions) =>
      key === "browserModelStrategy" || key === "browserThinkingTime" ? "cli" : "default";
    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.browserThinkingTime).toBe("extended");
  });

  test("preserves config-defined current strategy with its thinking time", () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        modelStrategy: "current",
        thinkingTime: "extended",
      },
    };

    applyBrowserDefaultsFromConfig(options, config, (_key) => "default");

    expect(options.browserModelStrategy).toBe("current");
    expect(options.browserThinkingTime).toBe("extended");
  });

  test.each(["select", "ignore"] as const)(
    "inherits thinking time when CLI requests %s strategy",
    (strategy) => {
      const options: BrowserDefaultsOptions = { browserModelStrategy: strategy };
      const config: UserConfig = { browser: { thinkingTime: "extended" } };
      const source = (key: keyof BrowserDefaultsOptions) =>
        key === "browserModelStrategy" ? "cli" : undefined;

      applyBrowserDefaultsFromConfig(options, config, source);

      expect(options.browserThinkingTime).toBe("extended");
    },
  );

  test.each([
    { args: ["--browser-model-strategy", "current"], expectedThinkingTime: undefined },
    {
      args: ["--browser-model-strategy", "current", "--browser-thinking-time", "extended"],
      expectedThinkingTime: "extended",
    },
  ])("honors Commander CLI option sources for $args", ({ args, expectedThinkingTime }) => {
    const program = new Command()
      .exitOverride()
      .addOption(
        new Option("--browser-model-strategy <mode>").choices(["select", "current", "ignore"]),
      )
      .addOption(
        new Option("--browser-thinking-time <level>").choices([
          "light",
          "standard",
          "extended",
          "heavy",
        ]),
      );
    program.parse(args, { from: "user" });
    const options = program.opts<BrowserDefaultsOptions>();
    const config: UserConfig = { browser: { thinkingTime: "heavy" } };

    applyBrowserDefaultsFromConfig(options, config, (key) => program.getOptionValueSource(key));

    expect(program.getOptionValueSource("browserModelStrategy")).toBe("cli");
    expect(options.browserThinkingTime).toBe(expectedThinkingTime);
  });

  test("applies manual-login defaults from config when CLI flags are untouched", () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        manualLogin: true,
        manualLoginProfileDir: "/tmp/oracle-profile",
        manualLoginCookieSync: true,
      },
    };

    applyBrowserDefaultsFromConfig(options, config, (_key) => "default");

    expect(options.browserManualLogin).toBe(true);
    expect(options.browserManualLoginProfileDir).toBe("/tmp/oracle-profile");
    expect(options.browserManualLoginCookieSync).toBe(true);
  });

  test("applies attach-running defaults from config when CLI flags are untouched", () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        attachRunning: true,
      },
    };

    applyBrowserDefaultsFromConfig(options, config, (_key) => "default");

    expect(options.browserAttachRunning).toBe(true);
  });

  test("attach-running skips conflicting launch-only defaults from config", () => {
    const options: BrowserDefaultsOptions = { browserAttachRunning: true };
    const config: UserConfig = {
      browser: {
        chromeProfile: "Default",
        chromeCookiePath: "/tmp/cookies",
        attachRunning: false,
        debugPort: 9222,
        timeoutMs: 120_000,
        headless: true,
        manualLoginCookieSync: true,
        hideWindow: true,
        keepBrowser: true,
        manualLogin: true,
        manualLoginProfileDir: "/tmp/oracle-profile",
        thinkingTime: "extended",
      },
    };
    const source = (key: keyof BrowserDefaultsOptions) =>
      key === "browserAttachRunning" ? "cli" : "default";

    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.browserAttachRunning).toBe(true);
    expect(options.browserChromeProfile).toBeUndefined();
    expect(options.browserCookiePath).toBeUndefined();
    expect(options.browserPort).toBeUndefined();
    expect(options.browserHeadless).toBeUndefined();
    expect(options.browserManualLoginCookieSync).toBeUndefined();
    expect(options.browserHideWindow).toBeUndefined();
    expect(options.browserKeepBrowser).toBeUndefined();
    expect(options.browserManualLogin).toBeUndefined();
    expect(options.browserManualLoginProfileDir).toBeUndefined();
    expect(options.browserTimeout).toBe("120000");
    expect(options.browserThinkingTime).toBe("extended");
  });

  test("saved attach-running also skips a saved headless preference", () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        attachRunning: true,
        headless: true,
        hideWindow: true,
      },
    };

    applyBrowserDefaultsFromConfig(options, config, (_key) => "default");

    expect(options.browserAttachRunning).toBe(true);
    expect(options.browserHeadless).toBeUndefined();
    expect(options.browserHideWindow).toBeUndefined();
  });

  test("does not override manual-login when CLI enabled it", () => {
    const options: BrowserDefaultsOptions = { browserManualLogin: true };
    const config: UserConfig = {
      browser: {
        manualLogin: false,
      },
    };

    const source = (key: keyof BrowserDefaultsOptions) =>
      key === "browserManualLogin" ? "cli" : "default";
    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.browserManualLogin).toBe(true);
  });
});
