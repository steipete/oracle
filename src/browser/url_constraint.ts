export interface UrlConstraint {
  readonly label: string;
  readonly allowedSchemes: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly allowedPaths?: readonly string[];
  readonly allowedPathPrefixes?: readonly string[];
  readonly requiredSearchParam?: {
    readonly name: string;
    readonly prefix?: string;
  };
}

export class UrlConstraintError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "UrlConstraintError";
  }
}

export function parsedAllowedUrlHostname(
  rawUrl: string | URL,
  allowedHosts: readonly string[],
): string | null {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  const allowedHostsSet = new Set(allowedHosts.map((entry) => entry.toLowerCase()));
  return allowedHostsSet.has(host) ? host : null;
}

export function urlHostnameMatchesAllowedHost(
  rawUrl: string | URL,
  allowedHosts: readonly string[],
): boolean {
  return parsedAllowedUrlHostname(rawUrl, allowedHosts) !== null;
}

export function assertConstrainedUrl(rawUrl: string | URL, constraint: UrlConstraint): URL {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  } catch {
    throw new UrlConstraintError(`${constraint.label} URL is not valid.`, "invalid_url");
  }

  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (!constraint.allowedSchemes.map((entry) => entry.toLowerCase()).includes(scheme)) {
    throw new UrlConstraintError(
      `${constraint.label} URL must use ${constraint.allowedSchemes.join(" or ")}.`,
      "invalid_scheme",
    );
  }

  const host = url.hostname.toLowerCase();
  const allowedHosts = new Set(constraint.allowedHosts.map((entry) => entry.toLowerCase()));
  if (!allowedHosts.has(host)) {
    throw new UrlConstraintError(
      `${constraint.label} URL host "${url.hostname}" is not trusted.`,
      "untrusted_host",
    );
  }

  if (constraint.allowedPaths && !constraint.allowedPaths.includes(url.pathname)) {
    throw new UrlConstraintError(
      `${constraint.label} URL path "${url.pathname}" is not allowed.`,
      "invalid_path",
    );
  }

  if (
    constraint.allowedPathPrefixes &&
    !constraint.allowedPathPrefixes.some((prefix) => url.pathname.startsWith(prefix))
  ) {
    throw new UrlConstraintError(
      `${constraint.label} URL path "${url.pathname}" is not allowed.`,
      "invalid_path",
    );
  }

  if (constraint.requiredSearchParam) {
    const value = url.searchParams.get(constraint.requiredSearchParam.name);
    const prefix = constraint.requiredSearchParam.prefix;
    if (!value || (prefix && !value.startsWith(prefix))) {
      throw new UrlConstraintError(
        `${constraint.label} URL is missing a trusted ${constraint.requiredSearchParam.name} parameter.`,
        "invalid_query",
      );
    }
  }

  return url;
}
