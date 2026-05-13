// Live-browser lease wrap (oracle-dsg).
//
// Pane 2 shipped `src/browser/leaseIntegration.ts` with
// `runBrowserWithLease` / `createLeasedBrowserExecutor`. The reality
// check found that the live runner path
// (`runBrowserSessionExecution → deps.executeBrowser ?? runBrowserMode`)
// never wraps the executor with that helper, so live `oracle --engine
// browser` runs submit prompts without acquiring or releasing a v18
// browser lease.
//
// This module is the additive call-site fix: a thin wrapper that
// auto-detects the provider from `BrowserRunOptions.config` and
// composes pane 2's `runBrowserWithLease`. Callers swap their raw
// executor for `wrapBrowserExecutorWithLease(executor, opts)` (or use
// `wrapWithLeaseOrPassthrough` for code paths that may not target a
// v18 protected slot). Pane 2's `leaseIntegration.ts` stays
// read-only — we only build on its public surface.

import type { BrowserLeaseProvider } from "../oracle/v18/browser_lease.js";
import {
  createLeasedBrowserExecutor,
  inferBrowserLeaseProviderFromDesiredModel,
  type BrowserExecutor,
  type BrowserLeaseIntegrationOptions,
  type LeasedBrowserExecutor,
} from "./leaseIntegration.js";
import type { BrowserRunOptions } from "./types.js";
import { urlHostnameMatchesAllowedHost } from "./url_constraint.js";

const CHATGPT_HOSTS = ["chatgpt.com", "chat.openai.com"] as const;
const GEMINI_HOSTS = ["gemini.google.com", "ai.google.dev"] as const;

/**
 * Detect the v18 lease provider for a given run. Examines (in order)
 * the explicit `provider` hint on the options, then the configured
 * ChatGPT/Gemini URL host. Returns `null` for runs that target
 * neither protected family — those stay on the legacy passthrough
 * path so ordinary Oracle browser use remains unchanged.
 */
export function detectBrowserLeaseProvider(
  runOptions: BrowserRunOptions,
): BrowserLeaseProvider | null {
  const explicit = (runOptions as { provider?: unknown }).provider;
  if (explicit === "chatgpt" || explicit === "gemini") return explicit;
  const url = runOptions.config?.chatgptUrl ?? runOptions.config?.url ?? null;
  if (typeof url === "string" && url.length > 0) {
    if (urlHostnameMatchesAllowedHost(url, CHATGPT_HOSTS)) return "chatgpt";
    if (urlHostnameMatchesAllowedHost(url, GEMINI_HOSTS)) return "gemini";
    return null;
  }
  return inferBrowserLeaseProviderFromDesiredModel(runOptions.config?.desiredModel);
}

export interface WrapBrowserExecutorOptions extends Omit<
  BrowserLeaseIntegrationOptions,
  "provider"
> {
  /** Optional explicit provider override; otherwise auto-detected per call. */
  readonly provider?: BrowserLeaseProvider;
}

/**
 * Wrap a `BrowserExecutor` so every call acquires a v18 browser lease
 * before delegating and releases it afterward. The returned executor
 * defers provider detection until invocation, so the same wrapper can
 * service both ChatGPT and Gemini calls in a multi-provider run.
 *
 * Throws if the run targets neither ChatGPT nor Gemini (callers should
 * use `wrapWithLeaseOrPassthrough` when the route may be ordinary
 * Oracle browser use).
 */
export function wrapBrowserExecutorWithLease(
  executor: BrowserExecutor,
  baseOptions: WrapBrowserExecutorOptions = {},
): LeasedBrowserExecutor {
  return async (runOptions) => {
    const provider = baseOptions.provider ?? detectBrowserLeaseProvider(runOptions);
    if (!provider) {
      throw new Error(
        "wrapBrowserExecutorWithLease: unable to detect ChatGPT/Gemini provider from run options; use wrapWithLeaseOrPassthrough for non-v18 routes.",
      );
    }
    const leased = createLeasedBrowserExecutor(executor, {
      ...baseOptions,
      provider,
    });
    return leased(runOptions);
  };
}

/**
 * Forgiving variant: routes ChatGPT/Gemini runs through the lease
 * wrapper, but falls back to the raw executor for ordinary Oracle
 * browser usage so the live runner can swap in this helper unconditionally
 * without breaking general-purpose browser commands.
 */
export function wrapWithLeaseOrPassthrough(
  executor: BrowserExecutor,
  baseOptions: WrapBrowserExecutorOptions = {},
): BrowserExecutor {
  return async (runOptions) => {
    const provider = baseOptions.provider ?? detectBrowserLeaseProvider(runOptions);
    if (!provider) {
      return executor(runOptions);
    }
    const leased = createLeasedBrowserExecutor(executor, {
      ...baseOptions,
      provider,
    });
    return leased(runOptions);
  };
}
