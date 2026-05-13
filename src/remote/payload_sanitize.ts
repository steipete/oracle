import type { BrowserSessionConfig } from "../sessionStore.js";
import type { RemoteRunPayload, RemoteAttachmentPayload } from "./types.js";

const SAFE_BROWSER_CONFIG_KEYS = [
  "url",
  "chatgptUrl",
  "timeoutMs",
  "inputTimeoutMs",
  "assistantRecheckDelayMs",
  "assistantRecheckTimeoutMs",
  "autoReattachDelayMs",
  "autoReattachIntervalMs",
  "autoReattachTimeoutMs",
  "desiredModel",
  "modelStrategy",
  "thinkingTime",
  "researchMode",
  "archiveConversations",
] as const satisfies readonly (keyof BrowserSessionConfig)[];

type SafeBrowserConfigKey = (typeof SAFE_BROWSER_CONFIG_KEYS)[number];

const SAFE_BROWSER_CONFIG_KEY_SET: ReadonlySet<string> = new Set(SAFE_BROWSER_CONFIG_KEYS);

export function sanitizeRemoteBrowserConfigForWire(
  config: BrowserSessionConfig | Record<string, unknown> | null | undefined,
): BrowserSessionConfig {
  return pickSafeBrowserConfig(config);
}

export function sanitizeRemoteRunPayloadForWire(payload: RemoteRunPayload): RemoteRunPayload {
  return {
    prompt: typeof payload.prompt === "string" ? payload.prompt : "",
    attachments: sanitizeAttachments(payload.attachments),
    ...(payload.fallbackSubmission
      ? {
          fallbackSubmission: {
            prompt:
              typeof payload.fallbackSubmission.prompt === "string"
                ? payload.fallbackSubmission.prompt
                : "",
            attachments: sanitizeAttachments(payload.fallbackSubmission.attachments),
          },
        }
      : {}),
    browserConfig: sanitizeRemoteBrowserConfigForWire(payload.browserConfig),
    options: sanitizeRunOptions(payload.options),
  };
}

export function serializeRemoteRunPayloadForWire(payload: RemoteRunPayload): string {
  return JSON.stringify(sanitizeRemoteRunPayloadForWire(payload));
}

export function sanitizeRemoteRunPayloadForHost(
  payload: RemoteRunPayload,
): RemoteRunPayload {
  const sanitized = sanitizeRemoteRunPayloadForWire(payload);
  return {
    ...sanitized,
    browserConfig: {
      ...sanitized.browserConfig,
      cookieSync: true,
      inlineCookies: null,
      inlineCookiesSource: null,
    },
  };
}

export function isSafeRemoteBrowserConfigKey(key: string): key is SafeBrowserConfigKey {
  return SAFE_BROWSER_CONFIG_KEY_SET.has(key);
}

function pickSafeBrowserConfig(
  config: BrowserSessionConfig | Record<string, unknown> | null | undefined,
): BrowserSessionConfig {
  if (!config || typeof config !== "object") {
    return {};
  }

  const out: Record<string, unknown> = {};
  for (const key of SAFE_BROWSER_CONFIG_KEYS) {
    const value = (config as Record<string, unknown>)[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as BrowserSessionConfig;
}

function sanitizeAttachments(value: unknown): RemoteAttachmentPayload[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Partial<RemoteAttachmentPayload> =>
      Boolean(entry && typeof entry === "object"),
    )
    .map((entry) => ({
      fileName: typeof entry.fileName === "string" ? entry.fileName : "attachment",
      displayPath: typeof entry.displayPath === "string" ? entry.displayPath : "attachment",
      ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
      contentBase64: typeof entry.contentBase64 === "string" ? entry.contentBase64 : "",
    }));
}

function sanitizeRunOptions(value: RemoteRunPayload["options"]): RemoteRunPayload["options"] {
  if (!value || typeof value !== "object") {
    return {};
  }
  return {
    ...(typeof value.heartbeatIntervalMs === "number"
      ? { heartbeatIntervalMs: value.heartbeatIntervalMs }
      : {}),
    ...(typeof value.verbose === "boolean" ? { verbose: value.verbose } : {}),
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(Array.isArray(value.followUpPrompts)
      ? {
          followUpPrompts: value.followUpPrompts.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
  };
}
