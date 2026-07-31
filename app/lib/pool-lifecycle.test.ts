import { describe, it, expect } from "vitest";
import { groupPoolsByPhase, poolPhase } from "@/lib/pool-lifecycle";

const NOW = 1_000_000n;

function pool(id: number, settled: boolean, periodEnd: bigint) {
  return { id: BigInt(id), settled, periodEnd };
}

describe("poolPhase", () => {
  it("is live only while the period end is strictly in the future", () => {
    expect(poolPhase(pool(1, false, NOW + 1n), NOW)).toBe("live");
    // Mirrors /api/goals/match: periodEnd === now is no longer live.
    expect(poolPhase(pool(1, false, NOW), NOW)).toBe("expired");
    expect(poolPhase(pool(1, false, NOW - 1n), NOW)).toBe("expired");
  });

  it("settled wins over any period state", () => {
    expect(poolPhase(pool(1, true, NOW + 100n), NOW)).toBe("settled");
    expect(poolPhase(pool(1, true, NOW - 100n), NOW)).toBe("settled");
  });
});

describe("groupPoolsByPhase", () => {
  it("splits pools into live, expired, and settled", () => {
    const grouped = groupPoolsByPhase(
      [
        pool(1, false, NOW + 50n),
        pool(2, false, NOW - 50n),
        pool(3, true, NOW - 200n),
      ],
      NOW,
    );
    expect(grouped.live.map((p) => p.id)).toEqual([1n]);
    expect(grouped.expired.map((p) => p.id)).toEqual([2n]);
    expect(grouped.settled.map((p) => p.id)).toEqual([3n]);
  });

  it("orders live pools soonest-ending first", () => {
    const grouped = groupPoolsByPhase(
      [
        pool(1, false, NOW + 300n),
        pool(2, false, NOW + 100n),
        pool(3, false, NOW + 200n),
      ],
      NOW,
    );
    expect(grouped.live.map((p) => p.id)).toEqual([2n, 3n, 1n]);
  });

  it("orders expired and settled pools most recently ended first", () => {
    const grouped = groupPoolsByPhase(
      [
        pool(1, false, NOW - 300n),
        pool(2, false, NOW - 100n),
        pool(3, true, NOW - 400n),
        pool(4, true, NOW - 200n),
      ],
      NOW,
    );
    expect(grouped.expired.map((p) => p.id)).toEqual([2n, 1n]);
    expect(grouped.settled.map((p) => p.id)).toEqual([4n, 3n]);
  });

  it("keeps input order on period-end ties", () => {
    const grouped = groupPoolsByPhase(
      [pool(1, false, NOW + 100n), pool(2, false, NOW + 100n)],
      NOW,
    );
    expect(grouped.live.map((p) => p.id)).toEqual([1n, 2n]);
  });

  it("keeps input order on ties in the reversed expired and settled sorts", () => {
    const grouped = groupPoolsByPhase(
      [
        pool(1, false, NOW - 100n),
        pool(2, false, NOW - 100n),
        pool(3, true, NOW - 100n),
        pool(4, true, NOW - 100n),
      ],
      NOW,
    );
    expect(grouped.expired.map((p) => p.id)).toEqual([1n, 2n]);
    expect(grouped.settled.map((p) => p.id)).toEqual([3n, 4n]);
  });

  it("does not mutate the input array", () => {
    const input = [
      pool(1, false, NOW + 300n),
      pool(2, true, NOW - 100n),
      pool(3, false, NOW - 200n),
    ];
    const snapshot = input.map((p) => p.id);
    groupPoolsByPhase(input, NOW);
    expect(input.map((p) => p.id)).toEqual(snapshot);
  });

  it("handles an empty list", () => {
    const grouped = groupPoolsByPhase([], NOW);
    expect(grouped.live).toEqual([]);
    expect(grouped.expired).toEqual([]);
    expect(grouped.settled).toEqual([]);
  });
});
