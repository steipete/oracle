import { describe, expect, test, vi } from "vitest";
import { registerFollowUpTool } from "../../src/mcp/tools/followUp.js";

describe("follow_up MCP tool", () => {
  test("starts a child follow-up session and returns status", async () => {
    const handlers: Array<(input: unknown) => Promise<unknown>> = [];
    const startBrowserFollowUpSession = vi.fn(async () => ({
      parentSessionId: "parent-session",
      parentConversationUrl: "https://chatgpt.com/c/abc123",
      session: {
        id: "child-session",
        status: "pending",
        options: {},
      },
      detached: true,
      finalizerStarted: true,
      reattachCommand: "oracle session child-session --render",
    }));
    const readFollowUpLogTail = vi.fn(async () => "log tail");
    registerFollowUpTool(
      {
        registerTool: (_name: string, _def: unknown, fn: (input: unknown) => Promise<unknown>) => {
          handlers.push(fn);
        },
      } as unknown as Parameters<typeof registerFollowUpTool>[0],
      {
        startBrowserFollowUpSession: startBrowserFollowUpSession as never,
        readFollowUpLogTail,
        cliEntrypoint: "/tmp/oracle-cli.js",
      },
    );
    const handler = handlers[0];
    if (!handler) throw new Error("handler not registered");

    const result = (await handler({
      parentSessionId: "parent-session",
      prompt: "continue this",
      slug: "child session now",
    })) as {
      content: Array<{ type: "text"; text: string }>;
      structuredContent: {
        sessionId: string;
        parentSessionId: string;
        status: string;
        logTail?: string;
      };
    };

    expect(startBrowserFollowUpSession).toHaveBeenCalledWith("parent-session", {
      prompt: "continue this",
      slug: "child session now",
      wait: undefined,
      files: undefined,
      cliEntrypoint: "/tmp/oracle-cli.js",
    });
    expect(result.structuredContent).toEqual({
      sessionId: "child-session",
      parentSessionId: "parent-session",
      status: "pending",
      logTail: "log tail",
    });
    expect(result.content[0]?.text).toContain("Follow-up session child-session");
  });

  test("rejects files because follow_up is prompt-only in v1", async () => {
    const handlers: Array<(input: unknown) => Promise<unknown>> = [];
    const startBrowserFollowUpSession = vi.fn();
    registerFollowUpTool(
      {
        registerTool: (_name: string, _def: unknown, fn: (input: unknown) => Promise<unknown>) => {
          handlers.push(fn);
        },
      } as unknown as Parameters<typeof registerFollowUpTool>[0],
      { startBrowserFollowUpSession: startBrowserFollowUpSession as never },
    );
    const handler = handlers[0];
    if (!handler) throw new Error("handler not registered");

    await expect(
      handler({ parentSessionId: "parent", prompt: "next", files: ["a.ts"] }),
    ).rejects.toThrow(/prompt-only/i);
    expect(startBrowserFollowUpSession).not.toHaveBeenCalled();
  });

  test("uses the waited session status when wait is requested", async () => {
    const handlers: Array<(input: unknown) => Promise<unknown>> = [];
    const startBrowserFollowUpSession = vi.fn(async () => ({
      parentSessionId: "parent-session",
      parentConversationUrl: "https://chatgpt.com/c/abc123",
      session: {
        id: "child-session",
        status: "pending",
        options: {},
      },
      detached: true,
      finalizerStarted: true,
      reattachCommand: "oracle session child-session --render",
    }));
    const waitForFollowUpSession = vi.fn(async () => ({
      id: "child-session",
      status: "completed",
    }));
    registerFollowUpTool(
      {
        registerTool: (_name: string, _def: unknown, fn: (input: unknown) => Promise<unknown>) => {
          handlers.push(fn);
        },
      } as unknown as Parameters<typeof registerFollowUpTool>[0],
      {
        startBrowserFollowUpSession: startBrowserFollowUpSession as never,
        waitForFollowUpSession: waitForFollowUpSession as never,
        readFollowUpLogTail: vi.fn(async () => undefined),
        waitMs: 123,
        pollMs: 45,
      },
    );
    const handler = handlers[0];
    if (!handler) throw new Error("handler not registered");

    const result = (await handler({
      parentSessionId: "parent-session",
      prompt: "continue this",
      wait: true,
    })) as {
      structuredContent: {
        status: string;
      };
    };

    expect(waitForFollowUpSession).toHaveBeenCalledWith("child-session", {
      timeoutMs: 123,
      pollMs: 45,
    });
    expect(result.structuredContent.status).toBe("completed");
  });
});
