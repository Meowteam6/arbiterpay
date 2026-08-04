import { describe, expect, it, vi } from "vitest";
import {
  isRetryableExternalError,
  isRetryableStatus,
  isTransportError,
  withRetry,
} from "@/lib/server/retry";

// These tests pin the two rules that make retrying safe rather than harmful:
// a non-retryable error must stop immediately (no wasted function budget, no
// repeated non-idempotent call), and the caller must always learn the truth
// when the attempts run out.

const NO_WAIT = [0, 0];

describe("withRetry", () => {
  it("returns the first success without retrying", async () => {
    const fn = vi.fn(() => Promise.resolve("ok"));
    await expect(withRetry(fn, { backoffMs: NO_WAIT })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and returns the eventual success", async () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls += 1;
      return calls < 3
        ? Promise.reject(new Error("fetch failed"))
        : Promise.resolve("ok");
    });
    await expect(
      withRetry(fn, { attempts: 3, backoffMs: NO_WAIT }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows the last error once the attempts are spent", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("still down")));
    await expect(
      withRetry(fn, { attempts: 3, backoffMs: NO_WAIT }),
    ).rejects.toThrow("still down");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops immediately when the error is not retryable", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("ALREADY_RECORDED")));
    await expect(
      withRetry(fn, {
        attempts: 5,
        backoffMs: NO_WAIT,
        isRetryable: (err) =>
          !/ALREADY_RECORDED/.test(
            err instanceof Error ? err.message : String(err),
          ),
      }),
    ).rejects.toThrow("ALREADY_RECORDED");
    // The whole point: one attempt, not five. A durable answer is not retried.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reports each retry to onRetry, but never for the final failure", async () => {
    const seen: number[] = [];
    const fn = vi.fn(() => Promise.reject(new Error("down")));
    await expect(
      withRetry(fn, {
        attempts: 3,
        backoffMs: NO_WAIT,
        onRetry: (_err, attempt) => seen.push(attempt),
      }),
    ).rejects.toThrow("down");
    expect(seen).toEqual([1, 2]);
  });

  it("waits between attempts", async () => {
    const started = Date.now();
    const fn = vi.fn(() => Promise.reject(new Error("down")));
    await expect(
      withRetry(fn, { attempts: 3, backoffMs: [20, 40] }),
    ).rejects.toThrow("down");
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it("reuses the last backoff value when attempts outrun the schedule", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("down")));
    await expect(
      withRetry(fn, { attempts: 4, backoffMs: [0] }),
    ).rejects.toThrow("down");
    expect(fn).toHaveBeenCalledTimes(4);
  });
});

describe("isRetryableStatus", () => {
  it("retries only statuses that mean try again", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status), String(status)).toBe(true);
    }
    for (const status of [200, 201, 400, 401, 403, 404, 409, 422]) {
      expect(isRetryableStatus(status), String(status)).toBe(false);
    }
  });
});

describe("isTransportError", () => {
  it("recognises aborts, timeouts, socket codes and fetch's opaque failure", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    const coded = Object.assign(new Error("boom"), { code: "ECONNRESET" });
    const wrapped = new Error("upstream unreachable", {
      cause: Object.assign(new Error("inner"), { code: "ENOTFOUND" }),
    });

    expect(isTransportError(abort)).toBe(true);
    expect(isTransportError(timeout)).toBe(true);
    expect(isTransportError(coded)).toBe(true);
    expect(isTransportError(wrapped)).toBe(true);
    expect(isTransportError(new TypeError("fetch failed"))).toBe(true);
  });

  it("does not mistake a refusal for a transport failure", () => {
    expect(isTransportError(new Error("invalid api key"))).toBe(false);
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
  });

  it("survives a self-referential cause chain", () => {
    const err = new Error("loop") as Error & { cause?: unknown };
    err.cause = err;
    expect(isTransportError(err)).toBe(false);
  });
});

describe("isRetryableExternalError", () => {
  it("reads the status out of the client error messages we throw", () => {
    expect(
      isRetryableExternalError(new Error("Junction /v2/user returned 503: x")),
    ).toBe(true);
    expect(
      isRetryableExternalError(new Error("Junction /v2/user returned 404: x")),
    ).toBe(false);
  });

  it("treats RPC rate limiting as retryable", () => {
    expect(
      isRetryableExternalError(new Error("HTTP request failed: request limit reached")),
    ).toBe(true);
    expect(isRetryableExternalError(new Error("execution reverted"))).toBe(
      false,
    );
  });
});
