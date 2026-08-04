// The provider split has one job: never let "the provider is refusing us"
// render as "you have not connected a device yet". The first is not the user's
// to fix, and offering them a connect flow for it is the dead end this
// classification exists to remove.

import { describe, it, expect } from "vitest";
import {
  parseProviderProgress,
  providerConnected,
  providerDownReason,
  providerQueryKey,
  providerStateFrom,
  providerUnavailableReason,
  type ProviderState,
} from "@/lib/wearable-provider";

const OK_BODY = {
  connected: true,
  metric: "Sleep score >= 75",
  streakDays: 4,
  targetDays: 7,
  lastSync: "2026-08-01",
};

describe("parseProviderProgress", () => {
  it("reads a full payload", () => {
    expect(parseProviderProgress(OK_BODY)).toEqual({
      connected: true,
      metric: "Sleep score >= 75",
      streakDays: 4,
      targetDays: 7,
      lastSync: "2026-08-01",
    });
  });

  it("defaults every field rather than trusting shapes it did not expect", () => {
    expect(parseProviderProgress(null)).toEqual({
      connected: false,
      metric: null,
      streakDays: null,
      targetDays: null,
      lastSync: null,
    });
    expect(
      parseProviderProgress({
        connected: "yes",
        streakDays: "4",
        targetDays: null,
      }),
    ).toEqual({
      connected: false,
      metric: null,
      streakDays: null,
      targetDays: null,
      lastSync: null,
    });
  });

  it("keeps a zero streak as a number, not a null", () => {
    expect(parseProviderProgress({ streakDays: 0 }).streakDays).toBe(0);
  });
});

describe("providerStateFrom", () => {
  it("treats any 2xx as the provider answering", () => {
    const state = providerStateFrom(200, OK_BODY);
    expect(state.kind).toBe("ok");
    expect(providerConnected(state)).toBe(true);
  });

  it("keeps a linked-nothing answer separate from an outage", () => {
    const state = providerStateFrom(200, { connected: false });
    expect(state.kind).toBe("ok");
    expect(providerConnected(state)).toBe(false);
    expect(providerDownReason(state)).toBeNull();
  });

  it("classifies the route's 502 as the provider being unavailable", () => {
    const state = providerStateFrom(502, {
      error: "Junction /v2/user returned 402: {\"detail\":\"trial ended\"}",
    });
    expect(state.kind).toBe("unavailable");
    expect(providerDownReason(state)).toContain("402");
  });
});

describe("providerUnavailableReason", () => {
  it("names payment-required as the app's problem, not the user's device", () => {
    const reason = providerUnavailableReason(502, {
      error: "Junction /v2/user returned 402: trial ended",
    });
    expect(reason).toContain("402");
    expect(reason.toLowerCase()).toContain("access");
    // The raw upstream body must never leak into the copy.
    expect(reason).not.toContain("trial ended");
  });

  it("names a credentials rejection", () => {
    expect(
      providerUnavailableReason(502, {
        error: "Junction /v2/user/providers/x returned 401: bad key",
      }),
    ).toContain("401");
  });

  it("reports the upstream status when it is some other failure", () => {
    expect(
      providerUnavailableReason(502, {
        error: "Junction /v2/summary/sleep/x returned 503: down",
      }),
    ).toContain("503");
  });

  it("falls back to the route status when no upstream status is quoted", () => {
    expect(providerUnavailableReason(500, { error: "boom" })).toContain("500");
    expect(providerUnavailableReason(504, null)).toContain("504");
  });
});

describe("providerConnected and providerDownReason", () => {
  it("answer nothing while the state is still loading", () => {
    const loading: ProviderState | undefined = undefined;
    expect(providerConnected(loading)).toBe(false);
    expect(providerDownReason(loading)).toBeNull();
  });
});

describe("providerQueryKey", () => {
  it("shares one key per address when no pool window is scoped", () => {
    expect(providerQueryKey("0xabc")).toEqual([
      "junction-progress",
      "0xabc",
      "none",
    ]);
  });

  it("scopes to a pool when a window is used", () => {
    expect(providerQueryKey("0xabc", 14n)).toEqual([
      "junction-progress",
      "0xabc",
      "14",
    ]);
  });
});
