import http from "node:http";
import https from "node:https";
import type { ResolvedProviderRoute } from "./providerRoutePlan.js";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface ProviderCredentialProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export async function probeProviderCredential(
  route: ResolvedProviderRoute,
  options: { timeoutMs?: number } = {},
): Promise<ProviderCredentialProbeResult> {
  if (!route.ok || !route.apiKey) {
    return { ok: false, error: route.error ?? `Missing ${route.keySource}.` };
  }

  try {
    const target = buildProbeTarget(route);
    const status = await requestStatus(target.url, target.headers, options.timeoutMs);
    if (status >= 200 && status < 300) {
      return { ok: true, status };
    }
    return {
      ok: false,
      status,
      error: `Credential validation failed (HTTP ${status}).`,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Credential validation failed (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

function buildProbeTarget(route: ResolvedProviderRoute): {
  url: URL;
  headers: Record<string, string>;
} {
  if (route.isAzureOpenAI) {
    const endpoint = route.azureEndpoint?.replace(/\/+$/, "");
    if (!endpoint) {
      throw new Error("Azure endpoint is missing");
    }
    const url = new URL(`${endpoint}/openai/models`);
    url.searchParams.set("api-version", "2024-10-21");
    return { url, headers: { "api-key": route.apiKey! } };
  }

  if (route.nativeProvider === "google") {
    return {
      url: appendModelsPath(route.baseUrl, "https://generativelanguage.googleapis.com/v1beta"),
      headers: { "x-goog-api-key": route.apiKey! },
    };
  }

  if (route.nativeProvider === "anthropic") {
    return {
      url: appendModelsPath(route.baseUrl, "https://api.anthropic.com/v1"),
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": route.apiKey!,
      },
    };
  }

  const fallbackBase =
    route.nativeProvider === "xai" ? "https://api.x.ai/v1" : "https://api.openai.com/v1";
  return {
    url: appendModelsPath(route.baseUrl, fallbackBase),
    headers: { authorization: `Bearer ${route.apiKey}` },
  };
}

function appendModelsPath(baseUrl: string | undefined, fallback: string): URL {
  const url = new URL(baseUrl?.trim() || fallback);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  url.search = "";
  url.hash = "";
  return url;
}

function requestStatus(
  url: URL,
  headers: Record<string, string>,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<number> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json", ...headers },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`timed out after ${timeoutMs}ms`));
    });
    request.once("error", reject);
    request.end();
  });
}
