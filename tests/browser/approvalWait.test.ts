import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveBrowserApprovalWait, resolveBrowserConfig } from "../../src/browser/config.js";
import { buildBrowserConfig } from "../../src/cli/browserConfig.js";
import {
  applyBrowserDefaultsFromConfig,
  type BrowserDefaultsOptions,
} from "../../src/cli/browserDefaults.js";

afterEach(() => vi.unstubAllEnvs());

describe("browser approval wait", () => {
  test("preserves the 20-second default", () => {
    vi.stubEnv("ORACLE_BROWSER_APPROVAL_WAIT", "");
    expect(resolveBrowserConfig(undefined).approvalWaitMs).toBe(20_000);
  });

  test.each([
    ["300000", 300_000],
    ["55s", 55_000],
    ["5m", 300_000],
    ["1m15s", 75_000],
  ])("accepts %s from the environment and CLI", async (value, expected) => {
    vi.stubEnv("ORACLE_BROWSER_APPROVAL_WAIT", value);
    expect(resolveBrowserConfig(undefined).approvalWaitMs).toBe(expected);
    expect(
      (await buildBrowserConfig({ model: "gpt-5.5", browserApprovalWait: value })).approvalWaitMs,
    ).toBe(expected);
    expect(resolveBrowserConfig({ approvalWaitMs: 40_000 }).approvalWaitMs).toBe(40_000);
  });

  test.each(["bad", "-1", "0", "999999999999h", 0, -1, Infinity, NaN, 2_147_483_648])(
    "rejects invalid or overflowing approval waits: %s",
    (value) => {
      expect(() => resolveBrowserApprovalWait(value)).toThrow(/Invalid browser approval wait/);
    },
  );

  test("maps saved configuration without overriding CLI or environment options", async () => {
    vi.stubEnv("ORACLE_BROWSER_APPROVAL_WAIT", "");
    const config = { browser: { approvalWaitMs: 300_000 } };
    const options: BrowserDefaultsOptions = {};
    applyBrowserDefaultsFromConfig(options, config, () => undefined);
    expect(options.browserApprovalWait).toBe("300000");
    expect(
      (
        await buildBrowserConfig({
          model: "gpt-5.5",
          browserApprovalWait: String(options.browserApprovalWait),
        })
      ).approvalWaitMs,
    ).toBe(300_000);
    for (const source of ["cli", "env"]) {
      const explicit = { browserApprovalWait: "55s" };
      applyBrowserDefaultsFromConfig(explicit, config, () => source);
      expect(explicit.browserApprovalWait).toBe("55s");
    }
  });
});
