// One shared reading of the wearable data provider, because every surface
// that offers a wearable action has to answer the same question honestly: can
// this goal be verified at all right now?
//
// Junction is a paid third party and its access can lapse - the API answers
// 402 and /api/junction/progress turns that into a 502. Before this module the
// browser could not tell "no device linked yet" (the user can fix that) from
// "the provider is refusing us" (the user cannot), so the UI offered a connect
// flow that could only ever fail, forever, with no way out.
//
// The split is a pure function of the response so it is testable under
// vitest's node environment, and every caller shares one react-query key so
// the endpoint is read once per address instead of once per component.

/** The derived, privacy-safe progress the API returns. Raw health samples
 *  never cross this boundary; only counts and labels do. */
export interface ProviderProgress {
  connected: boolean;
  metric: string | null;
  streakDays: number | null;
  targetDays: number | null;
  lastSync: string | null;
}

export type ProviderState =
  /** The provider answered. `connected` says whether a device is linked. */
  | { kind: "ok"; progress: ProviderProgress }
  /** The provider itself is the problem. Connecting a device cannot fix it. */
  | { kind: "unavailable"; reason: string };

/** The pool period a progress read can be scoped to. */
export interface ProviderWindow {
  periodStart: bigint;
  periodEnd: bigint;
}

export const PROVIDER_UNREACHABLE: ProviderState = {
  kind: "unavailable",
  reason: "Could not reach the wearable connection check.",
};

export function parseProviderProgress(payload: unknown): ProviderProgress {
  const record =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  return {
    connected: record.connected === true,
    metric: typeof record.metric === "string" ? record.metric : null,
    streakDays:
      typeof record.streakDays === "number" ? record.streakDays : null,
    targetDays:
      typeof record.targetDays === "number" ? record.targetDays : null,
    lastSync: typeof record.lastSync === "string" ? record.lastSync : null,
  };
}

// lib/server/junction.ts formats every upstream failure as
// `Junction <path> returned <status>: <body>`, and the route hands that
// string back as { error }. Reading the upstream status out of it is what
// lets the copy name the real cause instead of blaming the user's device.
const UPSTREAM_STATUS = /returned (\d{3})/;

function errorTextOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as Record<string, unknown>).error;
  return typeof error === "string" && error !== "" ? error : null;
}

/**
 * Plain-language reason a wearable read is impossible right now. Never quotes
 * the raw upstream body: it can carry provider account detail and reads as
 * noise to the person holding the phone.
 */
export function providerUnavailableReason(
  status: number,
  payload: unknown,
): string {
  const message = errorTextOf(payload);
  const upstream =
    message !== null ? (UPSTREAM_STATUS.exec(message)?.[1] ?? null) : null;
  if (upstream === "402") {
    return (
      "The wearable data provider has cut off this app's access (it answered " +
      "402, payment required). Nothing can be read from a wearable until that " +
      "is restored, so SPOTTER cannot verify a wearable goal right now."
    );
  }
  if (upstream === "401" || upstream === "403") {
    return (
      `The wearable data provider rejected this app's credentials (${upstream}). ` +
      "SPOTTER cannot read a wearable until that is fixed."
    );
  }
  if (upstream !== null) {
    return (
      `The wearable data provider answered ${upstream}, so nothing can be read ` +
      "from a wearable right now."
    );
  }
  return (
    `The wearable connection check responded ${status}, so nothing can be read ` +
    "from a wearable right now."
  );
}

/** Classify one /api/junction/progress response. */
export function providerStateFrom(
  status: number,
  payload: unknown,
): ProviderState {
  if (status >= 200 && status < 300) {
    return { kind: "ok", progress: parseProviderProgress(payload) };
  }
  return { kind: "unavailable", reason: providerUnavailableReason(status, payload) };
}

/** True only when the provider answered AND reports a linked device. */
export function providerConnected(state: ProviderState | undefined): boolean {
  return state?.kind === "ok" && state.progress.connected;
}

/**
 * Why wearable verification is impossible, or null when it is possible or not
 * known yet. Deliberately null while loading: a page must not disable a pool
 * on a guess.
 */
export function providerDownReason(
  state: ProviderState | undefined,
): string | null {
  return state?.kind === "unavailable" ? state.reason : null;
}

/**
 * React-query key for a provider read. Every consumer builds it here so the
 * dashboard, the pool list, the pool page, and the claim surface share one
 * cached response per (address, pool window) instead of hammering Junction.
 */
export function providerQueryKey(
  address: string | null,
  poolId?: bigint,
): (string | null)[] {
  return ["junction-progress", address, poolId?.toString() ?? "none"];
}

/**
 * Read the provider through the app's own route. Never throws: a thrown query
 * would render as a generic error, and the whole point of this module is that
 * "the provider is down" is a specific, actionable state.
 */
export async function fetchProviderState(
  address: `0x${string}`,
  window?: ProviderWindow,
): Promise<ProviderState> {
  const scope =
    window !== undefined
      ? `&start=${Number(window.periodStart)}&end=${Number(window.periodEnd)}`
      : "";
  try {
    const res = await fetch(`/api/junction/progress?address=${address}${scope}`);
    const payload = (await res.json().catch(() => null)) as unknown;
    return providerStateFrom(res.status, payload);
  } catch {
    return PROVIDER_UNREACHABLE;
  }
}
