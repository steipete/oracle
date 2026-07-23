import { describe, expect, test } from "vitest";
import {
  formatBrowserModelSelectionEvidence,
  formatBrowserModelTarget,
  formatBrowserModelWithRequestedKey,
  formatSessionBrowserModelWithRequestedKey,
  resolveBrowserModelDisplayName,
  resolveSessionBrowserModelDisplayName,
} from "../../src/browser/modelDisplay.js";

describe("browser model display", () => {
  test("labels the configured picker target separately from the requested CLI key", () => {
    expect(formatBrowserModelTarget({ model: "gpt-5.5-pro", desiredModel: "Pro" })).toBe(
      "target=Pro; requested=gpt-5.5-pro",
    );
    expect(formatBrowserModelTarget({ model: "gpt-5.6", desiredModel: "GPT-5.6 Sol" })).toBe(
      "target=GPT-5.6 Sol; requested=gpt-5.6",
    );
    expect(formatBrowserModelTarget({ model: "custom", desiredModel: "custom" })).toBe(
      "target=custom; requested=custom",
    );
  });

  test("does not present ignored or current picker state as a selection target", () => {
    expect(
      formatBrowserModelTarget({
        model: "gpt-5.5-pro",
        desiredModel: "Pro",
        modelStrategy: "current",
      }),
    ).toBe("picker=current; requested=gpt-5.5-pro");
    expect(
      formatBrowserModelTarget({
        model: "gpt-5.5-pro",
        desiredModel: "Pro",
        modelStrategy: "ignore",
      }),
    ).toBe("picker=ignore; requested=gpt-5.5-pro");
  });

  test("uses verified picker labels without expanding generic Pro to a GPT version", () => {
    const input = {
      model: "gpt-5.5-pro",
      evidence: {
        requestedModel: "Pro",
        resolvedLabel: "Pro",
        strategy: "select" as const,
        status: "already-selected" as const,
        verified: true,
        source: "chatgpt-model-picker" as const,
        capturedAt: "2026-07-12T00:00:00.000Z",
      },
    };

    expect(resolveBrowserModelDisplayName(input)).toBe("Pro");
    expect(formatBrowserModelWithRequestedKey(input)).toBe("Pro (requested gpt-5.5-pro)");
  });

  test("does not present unverified observed labels as the selected model", () => {
    expect(
      resolveBrowserModelDisplayName({
        model: "gpt-5.5-pro",
        evidence: {
          requestedModel: "gpt-5.5-pro",
          resolvedLabel: "Thinking 5.5 Heavy",
          strategy: "current",
          status: "already-selected",
          verified: false,
          source: "chatgpt-model-picker",
          capturedAt: "2026-07-12T00:00:00.000Z",
        },
      }),
    ).toBe("gpt-5.5-pro");

    expect(
      resolveBrowserModelDisplayName({
        model: "gpt-5.5-pro",
        evidence: {
          requestedModel: "Pro",
          resolvedLabel: "   ",
          strategy: "select",
          status: "already-selected",
          verified: true,
          source: "chatgpt-model-picker",
          capturedAt: "2026-07-12T00:00:00.000Z",
        },
      }),
    ).toBe("gpt-5.5-pro");
  });

  test("derives stored-session labels from verified evidence", () => {
    expect(
      resolveSessionBrowserModelDisplayName({
        id: "session",
        createdAt: "2026-07-12T00:00:00.000Z",
        status: "completed",
        mode: "browser",
        model: "gpt-5.6",
        options: {},
        browser: {
          modelSelection: {
            requestedModel: "GPT-5.6 Sol",
            resolvedLabel: "GPT-5.6 Sol",
            strategy: "select",
            status: "switched",
            verified: true,
            source: "chatgpt-model-picker",
            capturedAt: "2026-07-12T00:00:00.000Z",
          },
        },
      }),
    ).toBe("GPT-5.6 Sol");
  });

  test("does not apply session-level picker evidence to a different model run", () => {
    const metadata = {
      id: "session",
      createdAt: "2026-07-12T00:00:00.000Z",
      status: "completed" as const,
      mode: "browser" as const,
      model: "gpt-5.5-pro",
      options: {},
      browser: {
        modelSelection: {
          requestedModel: "Pro",
          resolvedLabel: "Pro",
          strategy: "select" as const,
          status: "already-selected" as const,
          verified: true,
          source: "chatgpt-model-picker" as const,
          capturedAt: "2026-07-12T00:00:00.000Z",
        },
      },
    };

    expect(formatSessionBrowserModelWithRequestedKey(metadata, "gpt-5.5-pro")).toBe(
      "Pro (requested gpt-5.5-pro)",
    );
    expect(formatSessionBrowserModelWithRequestedKey(metadata, "gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  test("formats model-selection provenance with stable field names", () => {
    expect(
      formatBrowserModelSelectionEvidence(
        {
          requestedModel: "Pro",
          resolvedLabel: "Pro",
          strategy: "select",
          status: "already-selected",
          verified: true,
          source: "chatgpt-model-picker",
          capturedAt: "2026-07-12T00:00:00.000Z",
        },
        "gpt-5.5-pro",
      ),
    ).toBe(
      "requestedKey=gpt-5.5-pro; target=Pro; resolvedLabel=Pro; status=already-selected; strategy=select; verified=yes; source=chatgpt-model-picker; capturedAt=2026-07-12T00:00:00.000Z",
    );
  });
});
