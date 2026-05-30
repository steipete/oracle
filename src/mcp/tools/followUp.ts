import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  readFollowUpLogTail,
  startBrowserFollowUpSession,
  waitForFollowUpSession,
} from "../../cli/browserFollowUp.js";
import { followUpInputSchema } from "../types.js";

const DEFAULT_MCP_FOLLOW_UP_WAIT_MS = 105_000;
const DEFAULT_MCP_FOLLOW_UP_POLL_MS = 2_000;

const followUpInputShape = {
  parentSessionId: z
    .string()
    .describe("Stored browser session id/slug whose saved ChatGPT conversation should continue."),
  prompt: z.string().describe("Follow-up prompt to send as the next ChatGPT turn."),
  slug: z.string().optional().describe("Optional child session slug (3-5 words)."),
  wait: z
    .boolean()
    .optional()
    .describe("Wait briefly for completion before returning. The child session remains detached."),
  files: z
    .array(z.string())
    .optional()
    .describe("Unsupported in follow_up v1; start a new consult to attach files."),
} satisfies z.ZodRawShape;

const followUpOutputShape = {
  sessionId: z.string(),
  parentSessionId: z.string(),
  status: z.string(),
  logTail: z.string().optional(),
} satisfies z.ZodRawShape;

interface FollowUpToolDeps {
  startBrowserFollowUpSession?: typeof startBrowserFollowUpSession;
  waitForFollowUpSession?: typeof waitForFollowUpSession;
  readFollowUpLogTail?: typeof readFollowUpLogTail;
  cliEntrypoint?: string;
  waitMs?: number;
  pollMs?: number;
}

function resolveMcpCliEntrypoint(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/oracle-cli.js");
}

function resolvePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function registerFollowUpTool(server: McpServer, deps: FollowUpToolDeps = {}): void {
  server.registerTool(
    "follow_up",
    {
      title: "Continue an oracle browser session",
      description:
        "Create a child Oracle session that sends one prompt to an existing stored ChatGPT browser conversation. This is prompt-only in v1; use consult for new file attachments.",
      inputSchema: followUpInputShape,
      outputSchema: followUpOutputShape,
    },
    async (input: unknown) => {
      const parsed = followUpInputSchema.parse(input);
      if (parsed.files && parsed.files.length > 0) {
        throw new Error(
          "Oracle follow_up is prompt-only in v1. Start a new consult to attach files.",
        );
      }
      const start = deps.startBrowserFollowUpSession ?? startBrowserFollowUpSession;
      const waitForSession = deps.waitForFollowUpSession ?? waitForFollowUpSession;
      const readLogTail = deps.readFollowUpLogTail ?? readFollowUpLogTail;
      const result = await start(parsed.parentSessionId, {
        prompt: parsed.prompt,
        slug: parsed.slug,
        wait: parsed.wait,
        files: parsed.files,
        cliEntrypoint: deps.cliEntrypoint ?? resolveMcpCliEntrypoint(),
      });
      const waitMs =
        deps.waitMs ??
        resolvePositiveIntegerEnv("ORACLE_MCP_BROWSER_WAIT_MS", DEFAULT_MCP_FOLLOW_UP_WAIT_MS);
      const pollMs =
        deps.pollMs ??
        resolvePositiveIntegerEnv("ORACLE_MCP_BROWSER_POLL_MS", DEFAULT_MCP_FOLLOW_UP_POLL_MS);
      const metadata = parsed.wait
        ? await waitForSession(result.session.id, { timeoutMs: waitMs, pollMs })
        : result.session;
      const status = metadata?.status ?? result.session.status;
      const logTail = await readLogTail(result.session.id, 4000);
      const output = `Follow-up session ${result.session.id} (${status}) from ${result.parentSessionId}. Reattach via: ${result.reattachCommand}`;
      return {
        content: [{ type: "text" as const, text: output }],
        structuredContent: {
          sessionId: result.session.id,
          parentSessionId: result.parentSessionId,
          status,
          logTail,
        },
      };
    },
  );
}
