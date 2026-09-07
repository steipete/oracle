import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client as ModernClient, LOG_LEVEL_META_KEY } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernTransport } from "@modelcontextprotocol/client/stdio";

describe.each(
  [
    { name: "SDK v1", Client: LegacyClient, Transport: LegacyTransport, modern: false },
    { name: "SDK v2 legacy", Client: ModernClient, Transport: ModernTransport, modern: false },
    { name: "SDK v2 modern", Client: ModernClient, Transport: ModernTransport, modern: true },
  ].flatMap((client) => ["standalone", "alias"].map((entrypoint) => ({ ...client, entrypoint }))),
)(
  "oracle-mcp stdio compatibility: $name / $entrypoint",
  ({ Client, Transport, modern, entrypoint }) => {
    test("discovers tools, previews a consult, reads durable resources, and closes", async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "oracle-mcp-compat-"));
      const dir = path.join(home, "sessions", "compat-session");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "meta.json"),
        JSON.stringify({
          id: "compat-session",
          createdAt: new Date().toISOString(),
          status: "completed",
          model: "gpt-5.4",
          mode: "api",
          cwd: home,
          options: { prompt: "Synthetic compatibility request", file: [], model: "gpt-5.4" },
        }),
      );
      await writeFile(path.join(dir, "output.log"), "Synthetic compatibility answer\n");
      await writeFile(
        path.join(dir, "request.json"),
        JSON.stringify({ prompt: "Synthetic compatibility request" }),
      );
      const client = new Client(
        { name: "oracle-compatibility-proof", version: "1.0.0" },
        modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined,
      );
      const transport = new Transport({
        command: process.execPath,
        args:
          entrypoint === "alias"
            ? [path.join(process.cwd(), "dist/bin/oracle-cli.js"), "oracle-mcp"]
            : [path.join(process.cwd(), "dist/bin/oracle-mcp.js")],
        env: { ...process.env, ORACLE_HOME_DIR: home, ORACLE_DISABLE_KEYTAR: "1" },
        stderr: "pipe",
      });
      const errors: Error[] = [];
      client.onerror = (error) => errors.push(error);
      try {
        await client.connect(transport);
        if (modern) {
          expect((client as ModernClient).getProtocolEra()).toBe("modern");
          expect((client as ModernClient).getNegotiatedProtocolVersion()).toBe("2026-07-28");
        }
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["consult", "chatgpt_image", "project_sources", "sessions"]),
        );
        for (const tool of tools.tools) {
          expect(tool.inputSchema.type).toBe("object");
          if (tool.outputSchema) expect(tool.outputSchema.type).toBe("object");
        }
        const preview = await client.callTool({
          name: "consult",
          arguments: { engine: "api", model: "gpt-5.4", prompt: "Synthetic preview", dryRun: true },
        });
        expect(preview.isError).not.toBe(true);
        expect(preview.structuredContent).toMatchObject({ status: "dry-run", dryRun: true });
        if (modern) {
          const messages: unknown[] = [];
          (client as ModernClient).setNotificationHandler(
            "notifications/message",
            (notification) => {
              messages.push(notification.params);
            },
          );
          await client.callTool({
            name: "consult",
            arguments: { engine: "api", model: "gpt-5.4", prompt: "Quiet preview", dryRun: true },
            _meta: { [LOG_LEVEL_META_KEY]: "error" },
          });
          expect(messages).toEqual([]);
          await client.callTool({
            name: "consult",
            arguments: { engine: "api", model: "gpt-5.4", prompt: "Verbose preview", dryRun: true },
            _meta: { [LOG_LEVEL_META_KEY]: "info" },
          });
          expect(messages.length).toBeGreaterThan(0);
        }
        expect(await readdir(path.join(home, "sessions"))).toEqual(["compat-session"]);
        const templates = await client.listResourceTemplates();
        expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toContain(
          "oracle-session://{id}/{kind}",
        );
        const log = await client.readResource({ uri: "oracle-session://compat-session/log" });
        expect(log.contents[0]).toMatchObject({ text: "Synthetic compatibility answer\n" });
        const metadata = await client.readResource({
          uri: "oracle-session://compat-session/metadata",
        });
        expect(JSON.parse((metadata.contents[0] as { text: string }).text)).toMatchObject({
          id: "compat-session",
          status: "completed",
        });
        expect(errors).toEqual([]);
        const pid = transport.pid;
        expect(pid).toBeTypeOf("number");
        await client.close();
        expect(transport.pid).toBeNull();
      } finally {
        await client.close();
        await rm(home, { recursive: true, force: true });
      }
    }, 20_000);
  },
);
