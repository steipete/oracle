import { describe, expect, test } from "vitest";

import {
  buildSessionLifecycle,
  formatSessionExecutionLabel,
  formatSessionLifecycleBlock,
} from "../../src/cli/sessionLifecycle.js";
import type { SessionMetadata } from "../../src/sessionManager.js";

describe("session lifecycle formatting", () => {
  test("formats detached API runs with reattach guidance", () => {
    const lifecycle = buildSessionLifecycle({
      engine: "api",
      detached: true,
      reattachCommand: "oracle session sess-123",
    });
    const meta = {
      id: "sess-123",
      createdAt: "2026-05-15T00:00:00.000Z",
      status: "running",
      mode: "api",
      options: {},
      models: [
        { model: "gpt-5.2-pro", status: "running" },
        { model: "gemini-3-pro", status: "running" },
      ],
      lifecycle,
    } as SessionMetadata;

    expect(formatSessionLifecycleBlock(meta)).toEqual([
      "Session: sess-123",
      "Mode: api background",
      "Models: 2 parallel",
      "Detach: yes, polling",
      "Reattach: oracle session sess-123",
    ]);
    expect(formatSessionExecutionLabel(meta)).toBe("api/bg");
  });

  test("formats attached browser runs compactly", () => {
    const lifecycle = buildSessionLifecycle({
      engine: "browser",
      detached: false,
      reattachCommand: "oracle session browser-1",
    });
    const meta = {
      id: "browser-1",
      createdAt: "2026-05-15T00:00:00.000Z",
      status: "running",
      mode: "browser",
      model: "gpt-5.2-pro",
      options: {},
      lifecycle,
    } as SessionMetadata;

    expect(formatSessionLifecycleBlock(meta)).toContain("Mode: browser foreground");
    expect(formatSessionLifecycleBlock(meta)).toContain("Detach: no");
    expect(formatSessionExecutionLabel(meta)).toBe("br/fg");
  });

  test("falls back to stored mode for legacy sessions", () => {
    const meta = {
      id: "legacy",
      createdAt: "2026-05-15T00:00:00.000Z",
      status: "completed",
      mode: "api",
      options: {},
    } as SessionMetadata;

    expect(formatSessionLifecycleBlock(meta)).toEqual([]);
    expect(formatSessionExecutionLabel(meta)).toBe("api");
  });
});
