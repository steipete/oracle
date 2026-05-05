import { describe, expect, test } from "vitest";
import {
  describeBrowserControlPlan,
  formatBrowserControlPlan,
} from "../../src/browser/controlPlan.js";

describe("browser control plan", () => {
  test("describes visible Chrome as a focus-taking launch", () => {
    const plan = describeBrowserControlPlan({});

    expect(plan).toMatchObject({
      mode: "visible-window",
      launchesChrome: true,
      mayFocusWindow: true,
    });
    expect(formatBrowserControlPlan(plan, "dry-run").join("\n")).toContain(
      "Browser control: launch visible Chrome",
    );
    expect(formatBrowserControlPlan(plan, "dry-run").join("\n")).toContain("--browser-hide-window");
  });

  test("describes attach-running as a lower-disruption existing browser flow", () => {
    const plan = describeBrowserControlPlan({ attachRunning: true });

    expect(plan).toMatchObject({
      mode: "attach-running",
      launchesChrome: false,
      mayFocusWindow: true,
    });
    expect(formatBrowserControlPlan(plan, "browser").join("\n")).toContain(
      "leaves the existing browser process alone",
    );
  });

  test("describes hidden and remote modes distinctly", () => {
    expect(describeBrowserControlPlan({ hideWindow: true }).mode).toBe("hidden-window");
    expect(
      describeBrowserControlPlan({ remoteChrome: { host: "127.0.0.1", port: 9222 } }).mode,
    ).toBe("remote-chrome");
    expect(describeBrowserControlPlan({ headless: true }).mode).toBe("headless");
  });
});
