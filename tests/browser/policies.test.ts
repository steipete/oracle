import { describe, expect, test } from "vitest";
import {
  buildAttachmentPlan,
  buildCookiePlan,
  shouldSyncBrowserCookies,
} from "../../src/browser/policies.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";

const sections = [
  { displayPath: "a.txt", absolutePath: "/repo/a.txt", content: "hello" },
  { displayPath: "b.txt", absolutePath: "/repo/b.txt", content: "world" },
];

describe("buildAttachmentPlan", () => {
  test("inlines files when requested", () => {
    const plan = buildAttachmentPlan(sections, {
      inlineFiles: true,
      bundleRequested: false,
    });
    expect(plan.mode).toBe("inline");
    expect(plan.inlineFileCount).toBe(2);
    expect(plan.attachments).toHaveLength(0);
    expect(plan.shouldBundle).toBe(false);
    expect(plan.inlineBlock).toContain("### File: a.txt");
    expect(plan.inlineBlock).toContain("Lines: 1-1");
    expect(plan.inlineBlock).toContain("1 | hello");
    expect(plan.inlineBlock).toContain("1 | world");
  });

  test("bundles multiple text uploads as one labelled corpus", () => {
    const many = Array.from({ length: 2 }, (_, i) => ({
      displayPath: `f${i}.txt`,
      absolutePath: `/repo/f${i}.txt`,
      content: "x",
    }));
    const plan = buildAttachmentPlan(many, {
      inlineFiles: false,
      bundleRequested: false,
    });
    expect(plan.mode).toBe("bundle");
    expect(plan.shouldBundle).toBe(true);
    expect(plan.attachments).toHaveLength(2);
  });

  test("keeps one text upload as its original attachment", () => {
    const plan = buildAttachmentPlan([sections[0]!], {
      inlineFiles: false,
      bundleRequested: false,
    });
    expect(plan.mode).toBe("upload");
    expect(plan.shouldBundle).toBe(false);
    expect(plan.attachments).toHaveLength(1);
  });

  test("forces bundle when requested even under threshold", () => {
    const plan = buildAttachmentPlan(sections, {
      inlineFiles: false,
      bundleRequested: true,
    });
    expect(plan.shouldBundle).toBe(true);
    expect(plan.mode).toBe("bundle");
  });
});

describe("buildCookiePlan", () => {
  test("inline cookies plan", () => {
    const plan = buildCookiePlan({
      inlineCookies: [{ name: "a", value: "1" }],
      inlineCookiesSource: "test",
    });
    expect(plan.type).toBe("inline");
    expect(plan.description).toContain("inline payload (1) via test");
  });

  test("disabled cookie sync plan", () => {
    const plan = buildCookiePlan({ cookieSync: false });
    expect(plan.type).toBe("disabled");
    expect(plan.description).toContain("Chrome copy disabled");
  });

  test("defaults to no Chrome cookie copy", () => {
    expect(buildCookiePlan({}).type).toBe("disabled");
  });

  test("copy from Chrome default allowlist", () => {
    const plan = buildCookiePlan({
      cookieSync: true,
      cookieNames: ["__Secure-next-auth.session-token", "_account"],
    });
    expect(plan.type).toBe("copy");
    expect(plan.description).toContain("__Secure-next-auth.session-token, _account");
  });
});

describe("shouldSyncBrowserCookies", () => {
  test("skips ordinary temporary profiles by default", () => {
    const config = resolveBrowserConfig(undefined);
    expect(shouldSyncBrowserCookies(config, { manualLogin: false })).toBe(false);
  });

  test("syncs ordinary temporary profiles when cookie sync is enabled", () => {
    const config = resolveBrowserConfig({ cookieSync: true });
    expect(shouldSyncBrowserCookies(config, { manualLogin: false })).toBe(true);
  });

  test("skips persistent manual-login profiles by default", () => {
    const config = resolveBrowserConfig({
      cookieSync: true,
      manualLogin: true,
      manualLoginCookieSync: false,
    });
    expect(shouldSyncBrowserCookies(config, { manualLogin: true })).toBe(false);
  });

  test("syncs persistent manual-login profiles only with the explicit opt-in", () => {
    const config = resolveBrowserConfig({
      cookieSync: true,
      manualLogin: true,
      manualLoginCookieSync: true,
    });
    expect(shouldSyncBrowserCookies(config, { manualLogin: true })).toBe(true);
  });

  test("does not sync a pre-signed copied profile", () => {
    const config = resolveBrowserConfig({ cookieSync: true });
    expect(shouldSyncBrowserCookies(config, { manualLogin: false, profileIsPreSigned: true })).toBe(
      false,
    );
  });
});
