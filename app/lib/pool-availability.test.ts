// Both splits guard a claim the page makes to a visitor. "Nobody joined" says
// a payout will never come; "cannot be verified" says do not pay the entry
// fee. Neither may be asserted on an unknown.

import { describe, it, expect } from "vitest";
import {
  splitByVerifiability,
  splitExpiredPools,
} from "@/lib/pool-availability";

function pool(id: number) {
  return { id: BigInt(id) };
}

describe("splitExpiredPools", () => {
  it("moves zero-participant pools out of the settlement group", () => {
    const counts: Record<string, number> = { "1": 0, "2": 3, "3": 0 };
    const split = splitExpiredPools([pool(1), pool(2), pool(3)], (p) =>
      counts[p.id.toString()],
    );
    expect(split.closedEmpty.map((p) => p.id)).toEqual([1n, 3n]);
    expect(split.awaitingSettlement.map((p) => p.id)).toEqual([2n]);
  });

  it("keeps an uncounted pool in the settlement group", () => {
    const split = splitExpiredPools([pool(1), pool(2)], (p) =>
      p.id === 1n ? null : 0,
    );
    expect(split.awaitingSettlement.map((p) => p.id)).toEqual([1n]);
    expect(split.closedEmpty.map((p) => p.id)).toEqual([2n]);
  });

  it("preserves the incoming order inside each group", () => {
    const split = splitExpiredPools([pool(3), pool(1), pool(2)], () => 0);
    expect(split.closedEmpty.map((p) => p.id)).toEqual([3n, 1n, 2n]);
  });

  it("handles an empty list", () => {
    const split = splitExpiredPools<{ id: bigint }>([], () => 0);
    expect(split.awaitingSettlement).toEqual([]);
    expect(split.closedEmpty).toEqual([]);
  });
});

describe("splitByVerifiability", () => {
  const pools = [
    { id: 1n, goalSpec: "Sleep score 75 for 7 nights" },
    { id: 2n, goalSpec: "[doc] Annual flu shot" },
    { id: 3n, goalSpec: "10000 steps a day for 5 days" },
  ];

  it("holds nothing back while the provider is up", () => {
    const split = splitByVerifiability(pools, false);
    expect(split.verifiable.map((p) => p.id)).toEqual([1n, 2n, 3n]);
    expect(split.unverifiable).toEqual([]);
  });

  it("holds back only wearable goals while the provider is down", () => {
    const split = splitByVerifiability(pools, true);
    expect(split.unverifiable.map((p) => p.id)).toEqual([1n, 3n]);
    // Document goals run through the TEE attester and are unaffected.
    expect(split.verifiable.map((p) => p.id)).toEqual([2n]);
  });

  it("does not mutate the input", () => {
    const input = [...pools];
    splitByVerifiability(input, true);
    expect(input.map((p) => p.id)).toEqual([1n, 2n, 3n]);
  });
});
