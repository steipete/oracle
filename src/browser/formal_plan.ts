import {
  errorCodeForFailure,
  isFailureState,
  isProLabel,
  type ChatGptProMachine,
} from "./providers/chatgptProVerification.js";
import type { V18ErrorCode } from "../oracle/v18/json_envelope.js";

export const CHATGPT_PRO_FORMAL_PLAN_ROUTE_SCHEMA_VERSION =
  "chatgpt_pro_formal_plan_route.v1" as const;

export type ChatGptProFormalPlanSlot = "chatgpt_pro_first_plan";
export type ChatGptProBrowserAccessPath = "oracle_browser_remote" | "oracle_browser_local";
export type ChatGptProRemoteBrowserPolicy = "preferred" | "required" | "off";

export interface ChatGptProFormalPlanRouteInput {
  readonly slot: ChatGptProFormalPlanSlot;
  readonly machine: ChatGptProMachine;
  readonly accessPath: ChatGptProBrowserAccessPath | string;
  readonly remoteBrowserPolicy?: ChatGptProRemoteBrowserPolicy;
}

export interface ChatGptProFormalPlanBlocker {
  readonly field: string;
  readonly code: V18ErrorCode;
  readonly message: string;
  readonly retry_safe: boolean;
  readonly details?: Record<string, unknown>;
}

export interface ChatGptProFormalPlanRouteDecision {
  readonly schema_version: typeof CHATGPT_PRO_FORMAL_PLAN_ROUTE_SCHEMA_VERSION;
  readonly ok: boolean;
  readonly slot: ChatGptProFormalPlanSlot;
  readonly status: "ready_to_submit" | "blocked";
  readonly can_submit_prompt: boolean;
  readonly access_path: string;
  readonly requested_mode: "ChatGPT Pro";
  readonly requested_reasoning_effort: "max_browser_available";
  readonly verified_before_prompt_submit: boolean;
  readonly mode_verified_same_session: boolean;
  readonly selected_effort_is_highest_visible: boolean;
  readonly observed_mode_label: string | null;
  readonly observed_reasoning_effort_label: string | null;
  readonly effort_rank: number | null;
  readonly available_effort_labels_hash: `sha256:${string}` | null;
  readonly selector_manifest_version: string | null;
  readonly session_id_hash: `sha256:${string}` | null;
  readonly blockers: ChatGptProFormalPlanBlocker[];
  readonly warnings: string[];
  readonly commands: {
    readonly doctor: string;
    readonly lease: string;
    readonly run: string;
  };
}

export function validateChatGptProFormalPlanRoute(
  input: ChatGptProFormalPlanRouteInput,
): ChatGptProFormalPlanRouteDecision {
  const blockers: ChatGptProFormalPlanBlocker[] = [];
  const warnings: string[] = [];
  const policy = input.remoteBrowserPolicy ?? "preferred";
  const machine = input.machine;
  const context = machine.context;
  const effort = context.effort;
  const accessPath = input.accessPath;

  if (input.slot !== "chatgpt_pro_first_plan") {
    blockers.push(
      blocker(
        "provider_slot",
        "chatgpt_pro_unverified",
        `Unsupported ChatGPT Pro formal-plan slot: ${input.slot}`,
        false,
      ),
    );
  }

  if (accessPath !== "oracle_browser_remote" && accessPath !== "oracle_browser_local") {
    blockers.push(
      blocker(
        "access_path",
        "chatgpt_pro_unverified",
        "ChatGPT Pro formal-plan routes must use Oracle browser access, never a direct API route.",
        false,
        { access_path: accessPath },
      ),
    );
  }

  if (policy === "required" && accessPath !== "oracle_browser_remote") {
    blockers.push(
      blocker(
        "remote_browser",
        "remote_browser_unavailable",
        "This ChatGPT Pro formal-plan route requires remote browser access.",
        true,
        { access_path: accessPath, remote_browser_policy: policy },
      ),
    );
  } else if (policy === "preferred" && accessPath === "oracle_browser_local") {
    warnings.push(
      "Remote browser is preferred for ChatGPT Pro formal-plan routes; using local browser access.",
    );
  }

  if (isFailureState(machine.state)) {
    blockers.push(
      blocker(
        "chatgpt_pro.state",
        errorCodeForFailure(machine.state),
        context.failureReason ?? `ChatGPT Pro verification failed in state ${machine.state}.`,
        isRetrySafeFailure(machine.state),
        { state: machine.state },
      ),
    );
  }

  if (!isProLabel(context.modelLabel ?? "")) {
    blockers.push(
      blocker(
        "chatgpt_pro.model_label",
        "chatgpt_pro_unverified",
        "ChatGPT Pro model selection has not been verified in this browser session.",
        false,
        { model_label: context.modelLabel },
      ),
    );
  }

  if (effort?.status !== "verified") {
    blockers.push(
      blocker(
        "chatgpt_pro.effort",
        effort?.errorCode ?? "chatgpt_extended_reasoning_unverified",
        effort?.reason ?? "Highest-visible ChatGPT reasoning effort has not been verified.",
        false,
      ),
    );
  } else if (effort.selectedIsHighestVisible !== true) {
    blockers.push(
      blocker(
        "chatgpt_pro.effort.selected_is_highest_visible",
        "chatgpt_extended_reasoning_unverified",
        "Selected ChatGPT reasoning effort is not the highest visible option.",
        false,
        { selected: effort.selected, rank: effort.rank },
      ),
    );
  }

  const modeVerifiedSameSession =
    machine.state === "mode_verified_same_session" &&
    effort?.status === "verified" &&
    effort.selectedIsHighestVisible === true &&
    Boolean(context.sessionIdHash);

  if (!modeVerifiedSameSession) {
    blockers.push(
      blocker(
        "chatgpt_pro.same_session_verification",
        "prompt_submitted_before_verification",
        "Prompt submission is blocked until ChatGPT Pro mode and highest-visible effort are verified in the same session.",
        false,
        { state: machine.state, session_id_hash_present: Boolean(context.sessionIdHash) },
      ),
    );
  }

  const uniqueBlockers = dedupeBlockers(blockers);
  const ok = uniqueBlockers.length === 0;
  return {
    schema_version: CHATGPT_PRO_FORMAL_PLAN_ROUTE_SCHEMA_VERSION,
    ok,
    slot: "chatgpt_pro_first_plan",
    status: ok ? "ready_to_submit" : "blocked",
    can_submit_prompt: ok,
    access_path: accessPath,
    requested_mode: "ChatGPT Pro",
    requested_reasoning_effort: "max_browser_available",
    verified_before_prompt_submit: ok,
    mode_verified_same_session: modeVerifiedSameSession,
    selected_effort_is_highest_visible: effort?.selectedIsHighestVisible === true,
    observed_mode_label: context.modelLabel,
    observed_reasoning_effort_label: effort?.selected ?? null,
    effort_rank: effort?.rank ?? null,
    available_effort_labels_hash: effort?.availableEffortLabelsHash ?? null,
    selector_manifest_version:
      effort?.selectorManifestVersion ?? context.selectorManifestVersion ?? null,
    session_id_hash: context.sessionIdHash,
    blockers: uniqueBlockers,
    warnings,
    commands: {
      doctor: "oracle doctor chatgpt --pro --extended-reasoning --remote-browser preferred --json",
      lease:
        "oracle browser leases acquire --providers chatgpt --require pro --remote-browser preferred --ttl-seconds 1800 --json",
      run: "oracle --engine browser --provider chatgpt --model chatgpt-pro-latest --chatgpt-pro --extended-reasoning --remote-browser preferred --evidence redacted --prompt-file PROMPT.md --json",
    },
  };
}

function blocker(
  field: string,
  code: V18ErrorCode,
  message: string,
  retrySafe: boolean,
  details?: Record<string, unknown>,
): ChatGptProFormalPlanBlocker {
  return {
    field,
    code,
    message,
    retry_safe: retrySafe,
    ...(details ? { details } : {}),
  };
}

function dedupeBlockers(
  blockers: readonly ChatGptProFormalPlanBlocker[],
): ChatGptProFormalPlanBlocker[] {
  const seen = new Set<string>();
  return blockers.filter((entry) => {
    const key = `${entry.field}:${entry.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRetrySafeFailure(state: string): boolean {
  return state === "remote_browser_unavailable" || state === "usage_limit";
}
