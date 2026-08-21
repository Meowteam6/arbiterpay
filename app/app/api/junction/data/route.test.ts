// GET /api/junction/data returns the owner's recent per-day sleep + activity
// for their own dashboard. This route DOES surface per-day sleep hours and
// step counts - so the signature gate is the whole protection, and it is what
// this file pins:
//
//   - NO SIGNATURE, NO READ. A wallet address is public; without the EIP-191
//     signature proving control of it, getRecent is never called and the
//     answer is 401. That is what stops a stranger reading someone's sleep
//     hours and steps by copying an address out of a pool. (The verdict/settle
//     spine never touches this route: raw per-day data reaches the account
//     holder's own authenticated browser and nowhere else - not the chain, not
//     the agent's reasoning, not a marketplace service.)
//   - not-connected is connected:false with empty arrays, not a 404.
//   - an upstream failure is an opaque 502 with the real cause logged; a
//     missing/invalid JUNCTION_API_KEY surfaces here as a down provider.

import { describe, it, expect, vi, beforeEach } from "vitest";

const getRecent = vi.fn();
const isConnected = vi.fn();
const requireAddressSignature = vi.fn();

vi.mock("@/lib/server/junction", () => ({
  getRecent: (...args: unknown[]) => getRecent(...args),
  isConnected: (...args: unknown[]) => isConnected(...args),
}));
vi.mock("@/lib/server/wallet-auth", () => ({
  requireAddressSignature: (...args: unknown[]) =>
    requireAddressSignature(...args),
}));

const { GET } = await import("@/app/api/junction/data/route");
const { NextRequest } = await import("next/server");

const USER = "0x1111111111111111111111111111111111111111";

function get(query: string) {
  return GET(new NextRequest(`http://localhost/api/junction/data${query}`));
}

const RECENT = {
  sleep: [{ date: "2026-08-16", score: 88, hours: 7.4 }],
  activity: [{ date: "2026-08-16", steps: 10200 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAddressSignature.mockResolvedValue({ ok: true, address: USER });
  isConnected.mockResolvedValue(true);
  getRecent.mockResolvedValue(RECENT);
});

describe("GET /api/junction/data", () => {
  it("rejects a malformed address before auth or any read", async () => {
    const res = await get("?address=0xnope");
    expect(res.status).toBe(400);
    expect(requireAddressSignature).not.toHaveBeenCalled();
    expect(getRecent).not.toHaveBeenCalled();
  });

  it("refuses an unsigned read: 401 and NO per-day health data is read", async () => {
    requireAddressSignature.mockResolvedValue({
      ok: false,
      reason: "signature proves control of a different address",
    });
    const res = await get(`?address=${USER}`);
    expect(res.status).toBe(401);
    // The boundary: the raw sleep hours and steps are never even fetched.
    expect(isConnected).not.toHaveBeenCalled();
    expect(getRecent).not.toHaveBeenCalled();
  });

  it("reports not-connected as connected:false with empty arrays", async () => {
    isConnected.mockResolvedValue(false);
    const res = await get(`?address=${USER}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connected: false,
      sleep: [],
      activity: [],
    });
    expect(getRecent).not.toHaveBeenCalled();
  });

  it("returns the owner's recent data once signed and connected", async () => {
    const res = await get(`?address=${USER}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true, ...RECENT });
    expect(getRecent).toHaveBeenCalledWith(USER, 7);
  });

  it("clamps an out-of-range days param to the 7-day default", async () => {
    await get(`?address=${USER}&days=999`);
    expect(getRecent).toHaveBeenCalledWith(USER, 7);
  });

  it("honours a valid days param", async () => {
    await get(`?address=${USER}&days=14`);
    expect(getRecent).toHaveBeenCalledWith(USER, 14);
  });

  it("answers an upstream failure with a generic 502 and logs the real cause", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    getRecent.mockRejectedValue(
      new Error("Junction /v2/summary/sleep/vital-1 returned 402: payment required"),
    );
    const res = await get(`?address=${USER}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Health data is temporarily unavailable");
    expect(body.error).not.toContain("402");
    expect(body.error).not.toContain("summary");
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0])).toContain("402");
    consoleError.mockRestore();
  });
});
