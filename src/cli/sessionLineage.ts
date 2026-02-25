import type { SessionMetadata } from '../sessionStore.js';

type ResponseRecord = { responseId?: unknown; id?: unknown };

export interface SessionLineage {
  parentResponseId: string;
  parentSessionId?: string;
}

function readResponseId(record: ResponseRecord | undefined | null): string | null {
  if (!record) return null;
  const candidate =
    typeof record.responseId === 'string' ? record.responseId : typeof record.id === 'string' ? record.id : null;
  if (!candidate || !candidate.startsWith('resp_')) {
    return null;
  }
  return candidate;
}

export function collectSessionResponseIds(meta: SessionMetadata): string[] {
  const ids = new Set<string>();
  const rootResponse = readResponseId(meta.response as ResponseRecord | undefined);
  if (rootResponse) {
    ids.add(rootResponse);
  }
  const runs = Array.isArray(meta.models) ? meta.models : [];
  for (const run of runs) {
    const runResponse = readResponseId((run as unknown as { response?: ResponseRecord | null }).response);
    if (runResponse) {
      ids.add(runResponse);
    }
  }
  return [...ids];
}

export function buildResponseOwnerIndex(sessions: SessionMetadata[]): Map<string, string> {
  const byResponse = new Map<string, string>();
  for (const session of sessions) {
    for (const responseId of collectSessionResponseIds(session)) {
      if (!byResponse.has(responseId)) {
        byResponse.set(responseId, session.id);
      }
    }
  }
  return byResponse;
}

export function resolveSessionLineage(
  meta: SessionMetadata,
  responseOwners?: ReadonlyMap<string, string>,
): SessionLineage | null {
  const previous = meta.options?.previousResponseId?.trim();
  if (!previous) {
    return null;
  }
  let parentSessionId = meta.options?.followupSessionId?.trim();
  if (!parentSessionId && responseOwners) {
    parentSessionId = responseOwners.get(previous);
  }
  if (parentSessionId === meta.id) {
    parentSessionId = undefined;
  }
  return { parentResponseId: previous, parentSessionId };
}

export function abbreviateResponseId(responseId: string, max = 18): string {
  if (responseId.length <= max) {
    return responseId;
  }
  const head = Math.max(8, max - 7);
  return `${responseId.slice(0, head)}...${responseId.slice(-4)}`;
}
