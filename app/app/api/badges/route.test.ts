// GET /api/badges is a public, read-only badge grid. What this pins:
//   - a malformed/missing address is rejected 400 BEFORE any badge read;
//   - a valid address returns the getBadges grid verbatim as JSON;
//   - a last-resort failure is an opaque 500 (no infra detail leaked).

import { describe, it, expect, vi, beforeEach } from "vitest";

const getBadges = vi.fn();

vi.mock("@/lib/badges", () => ({
  getBadges: (...args: unknown[]) => getBadges(...args),
}));

const { GET } = await import("@/app/api/badges/route");
const { NextRequest } = await import("next/server");

const USER = "0x1111111111111111111111111111111111111111";

function get(query: string) {
  return GET(new NextRequest(`http://localhost/api/badges${query}`));
}

const GRID = {
  earnedCount: 1,
  total: 10,
  badges: [
    {
      id: "first-steps",
      name: "First Steps",
      blurb: "Joined your first pool or challenge",
      iconKey: "first-steps",
      earned: true,
      earnedAt: null,
      progress: null,
      lockedHint: "Join a pool or accept a challenge",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  getBadges.mockResolvedValue(GRID);
});

describe("GET /api/badges", () => {
  it("rejects a missing address with 400 and never reads badges", async () => {
    const res = await get("");
    expect(res.status).toBe(400);
    expect(getBadges).not.toHaveBeenCalled();
  });

  it("rejects a malformed address with 400 and never reads badges", async () => {
    const res = await get("?address=0xnope");
    expect(res.status).toBe(400);
    expect(getBadges).not.toHaveBeenCalled();
  });

  it("returns the grid verbatim for a valid address", async () => {
    const res = await get(`?address=${USER}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(GRID);
    expect(getBadges).toHaveBeenCalledWith(USER);
  });

  it("answers an unexpected failure with an opaque 500", async () => {
    getBadges.mockRejectedValue(
      new Error("https://rpc.testnet.arc.network exploded: secret detail"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const res = await get(`?address=${USER}`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("rpc.testnet.arc.network");
    expect(body.error).not.toContain("secret detail");
    consoleError.mockRestore();
  });
});
