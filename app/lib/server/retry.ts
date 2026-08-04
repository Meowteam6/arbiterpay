// Retry-with-backoff for external calls (server only).
//
// WHY THIS EXISTS
//
// The repo had exactly one retry loop — the HealthVerdict registry write in
// verdict.ts — and every other external call was one-shot. A single rate-limit
// blip at the public Arc RPC, or one 502 from the attester, therefore became a
// user-visible failure even though the very next request would have succeeded.
//
// The rules encoded here, so callers cannot get them wrong:
//   - retry only what is SAFE to repeat. Reads are. Writes are not, unless the
//     remote end is idempotent by construction (the registry write simulates
//     first and reverts ALREADY_RECORDED, so a repeat cannot double-write).
//   - retry only what is PLAUSIBLY transient. A 401 or a 400 will fail exactly
//     the same way three times; burning the function budget on it helps nobody.
//   - the caller always learns the truth. withRetry rethrows the last error
//     rather than swallowing it into a default value.

/** Backoff before attempts 2 and 3. Keeps a polling endpoint responsive. */
export const DEFAULT_BACKOFF_MS = [400, 1200];

export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** Delay before attempt N+1. The last value repeats if attempts exceeds it. */
  backoffMs?: number[];
  /** Decides whether an error is worth another attempt. Default: retry all. */
  isRetryable?: (err: unknown) => boolean;
  /** Called before each retry, for logging. Never throws into the caller. */
  onRetry?: (err: unknown, attempt: number, attempts: number) => void;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient failures with backoff. Rethrows the last error
 * once the attempts are spent, or immediately when `isRetryable` says no.
 *
 * ONLY for idempotent operations. Do not wrap a call that moves money or
 * creates a record unless repeating it is provably a no-op.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const backoffMs =
    options.backoffMs !== undefined && options.backoffMs.length > 0
      ? options.backoffMs
      : DEFAULT_BACKOFF_MS;
  const isRetryable = options.isRetryable ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLast = attempt === attempts;
      if (isLast || !isRetryable(err)) throw err;
      options.onRetry?.(err, attempt, attempts);
      await sleep(backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1]);
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastError;
}

/**
 * HTTP statuses worth another attempt: the server said it could not serve this
 * request right now. Everything else (auth, validation, not-found) is a durable
 * answer and retrying it is just latency.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Whether a thrown value looks like a transport failure rather than a refusal.
 * Covers fetch's opaque "fetch failed", abort/timeout errors, and the usual
 * Node socket codes. Deliberately generous: the cost of one extra read attempt
 * is far below the cost of a claim failing on a socket hiccup.
 */
export function isTransportError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err === "object") {
    const name = (err as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") return true;
    const code = (err as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR)/.test(
        code,
      )
    ) {
      return true;
    }
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== err && isTransportError(cause)) {
      return true;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return /fetch failed|network|socket|timed? ?out|aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(
    message,
  );
}

/**
 * Retryable if it is a transport failure OR a retryable-status HTTP error. Use
 * for calls that throw a plain Error carrying the status in its message (the
 * shape the Junction and attester clients already use).
 */
export function isRetryableExternalError(err: unknown): boolean {
  if (isTransportError(err)) return true;
  const message = err instanceof Error ? err.message : String(err);
  const match = /\breturned (\d{3})\b/.exec(message);
  if (match !== null) return isRetryableStatus(Number(match[1]));
  // viem surfaces rate limiting and RPC unavailability as prose.
  return /rate limit|request limit|too many requests|service unavailable|bad gateway|gateway timeout/i.test(
    message,
  );
}
