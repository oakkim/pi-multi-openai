/**
 * Failure classification: decides WHY a request failed so the pool knows
 * whether to cool an account down briefly (rate limit), for hours (usage
 * limit), or disable it entirely (bad credentials).
 */

export type FailureClass = "usage" | "rate" | "auth" | "transient" | "aborted" | "other";

export interface Failure {
  cls: FailureClass;
  /** Epoch ms when the account may recover, when the provider told us. */
  until?: number;
}

const USAGE_RE =
  /insufficient_quota|usage[^.\n]{0,40}limit|exceeded your current quota|quota[^.\n]{0,20}(exceeded|exhaust)|out of (?:budget|credits?)|billing|payment required|credit balance|GoUsageLimitError|FreeUsageLimitError|monthly usage/i;
const RATE_RE = /rate[_ .-]?limit|too many requests|429|overloaded|capacity|temporarily unavailable/i;
const AUTH_RE =
  /invalid[^.\n]{0,30}(api[_ .-]?key|token)|incorrect api key|unauthorized|invalid_grant|token[^.\n]{0,30}(expired|revoked)|authentication/i;
const TRANSIENT_RE = /connect|timeout|timed out|network|ECONNRESET|socket hang up|fetch failed|ETIMEDOUT|EAI_AGAIN/i;
const ABORT_RE = /abort/i;

const RESET_AT_RE =
  /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

/** Parse "resets at <time>" / "try again at <time>" style timestamps. */
export function parseResetTime(text: string, now = Date.now()): number | undefined {
  const m = RESET_AT_RE.exec(text);
  if (!m) return undefined;
  const ts = Date.parse(m[1].replace(" ", "T"));
  if (!Number.isFinite(ts) || ts <= now) return undefined;
  return ts;
}

/** Parse a Retry-After header (seconds or HTTP date) into an epoch ms. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return now + secs * 1000;
  const ts = Date.parse(value);
  if (Number.isFinite(ts) && ts > now) return ts;
  return undefined;
}

export function classifyFailure(
  errorMessage: string,
  status?: number,
  headers?: Record<string, string>,
  aborted = false,
  now = Date.now(),
): Failure {
  if (aborted || (status === undefined && ABORT_RE.test(errorMessage))) {
    return { cls: "aborted" };
  }
  const text = errorMessage ?? "";

  if (status === 401 || AUTH_RE.test(text)) {
    return { cls: "auth" };
  }
  if (status === 402 || USAGE_RE.test(text)) {
    return { cls: "usage", until: parseResetTime(text, now) };
  }
  if (status === 429 || RATE_RE.test(text)) {
    const retryAfter = headers ? findHeader(headers, "retry-after") : undefined;
    return { cls: "rate", until: parseRetryAfter(retryAfter, now) ?? parseResetTime(text, now) };
  }
  if ((status !== undefined && status >= 500) || TRANSIENT_RE.test(text)) {
    return { cls: "transient" };
  }
  return { cls: "other" };
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
