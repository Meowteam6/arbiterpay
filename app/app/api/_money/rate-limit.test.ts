// Exercises the file-backed path of the spend windows, which is what local
// dev and CI run. The Redis path uses the same pure verdict function and the
// same bucket keys; what is proved here is the part that used to be wrong:
// concurrent reservations must not both pass.

import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import {
  LEDGER_LOCK,
  claimOncePerWindow,
  releaseFromWindow,
  releaseOncePerWindow,
  spendFromWindow,
  withLock,
} from "@/app/api/_money/rate-limit";

const WINDOW_MS = 60_000;
const NOW = 1_800_000_000_000;

async function resetStore(): Promise<void> {
  const dir = process.env.DATA_DIR;
  if (dir === undefined) throw new Error("DATA_DIR must be set for this test");
  await fs.rm(path.join(dir, "spend-windows.json"), { force: true });
}

/** Unique key per test so a leftover bucket cannot leak between cases. */
let counter = 0;
function key(): string {
  counter += 1;
  return `test:${counter}:${Math.random().toString(36).slice(2)}`;
}

describe("spendFromWindow", () => {
  beforeEach(resetStore);

  it("allows reservations up to the cap and then denies", async () => {
    const name = key();
    const first = await spendFromWindow(name, 60n, 100n, WINDOW_MS, NOW);
    expect(first.kind).toBe("allow");
    expect(first.remainingUusdc).toBe(40n);

    const second = await spendFromWindow(name, 40n, 100n, WINDOW_MS, NOW);
    expect(second.kind).toBe("allow");
    expect(second.remainingUusdc).toBe(0n);

    const third = await spendFromWindow(name, 1n, 100n, WINDOW_MS, NOW);
    expect(third.kind).toBe("deny");
    expect(third.remainingUusdc).toBe(0n);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("does not consume the cap on a denied reservation", async () => {
    const name = key();
    expect((await spendFromWindow(name, 90n, 100n, WINDOW_MS, NOW)).kind).toBe(
      "allow",
    );
    // Denied: too big. It must not eat the remaining 10.
    expect((await spendFromWindow(name, 50n, 100n, WINDOW_MS, NOW)).kind).toBe(
      "deny",
    );
    expect((await spendFromWindow(name, 10n, 100n, WINDOW_MS, NOW)).kind).toBe(
      "allow",
    );
  });

  it("holds the cap under concurrent reservations", async () => {
    // The bug this module exists to prevent: a read-then-write counter lets
    // simultaneous callers all observe the same total and all pass.
    const name = key();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        spendFromWindow(name, 10n, 100n, WINDOW_MS, NOW),
      ),
    );
    const allowed = results.filter((r) => r.kind === "allow").length;
    expect(allowed).toBe(10);
  });

  it("denies an amount larger than the cap without touching the counter", async () => {
    const name = key();
    // Caller-influenced amounts must never reach the counter unclamped: a
    // 10^30 request would be converted lossily on its way to being denied.
    const huge = await spendFromWindow(name, 10n ** 30n, 100n, WINDOW_MS, NOW);
    expect(huge.kind).toBe("deny");
    expect(huge.remainingUusdc).toBe(100n);

    // The counter is untouched, so the full cap is still spendable.
    const after = await spendFromWindow(name, 100n, 100n, WINDOW_MS, NOW);
    expect(after.kind).toBe("allow");
  });

  it("reports the true remainder when refusing an oversized amount", async () => {
    const name = key();
    await spendFromWindow(name, 70n, 100n, WINDOW_MS, NOW);
    const oversized = await spendFromWindow(name, 500n, 100n, WINDOW_MS, NOW);
    expect(oversized.kind).toBe("deny");
    expect(oversized.remainingUusdc).toBe(30n);
  });

  it("denies a non-positive amount", async () => {
    const name = key();
    expect((await spendFromWindow(name, 0n, 100n, WINDOW_MS, NOW)).kind).toBe(
      "deny",
    );
    expect((await spendFromWindow(name, -5n, 100n, WINDOW_MS, NOW)).kind).toBe(
      "deny",
    );
    expect((await spendFromWindow(name, 100n, 100n, WINDOW_MS, NOW)).kind).toBe(
      "allow",
    );
  });

  it("resets when the window rolls over", async () => {
    const name = key();
    expect((await spendFromWindow(name, 100n, 100n, WINDOW_MS, NOW)).kind).toBe(
      "allow",
    );
    expect((await spendFromWindow(name, 1n, 100n, WINDOW_MS, NOW)).kind).toBe(
      "deny",
    );
    const next = NOW + WINDOW_MS;
    expect((await spendFromWindow(name, 100n, 100n, WINDOW_MS, next)).kind).toBe(
      "allow",
    );
  });

  it("keeps separate names independent", async () => {
    const a = key();
    const b = key();
    expect((await spendFromWindow(a, 100n, 100n, WINDOW_MS, NOW)).kind).toBe(
      "allow",
    );
    expect((await spendFromWindow(b, 100n, 100n, WINDOW_MS, NOW)).kind).toBe(
      "allow",
    );
  });
});

describe("releaseFromWindow", () => {
  beforeEach(resetStore);

  it("gives an unused reservation back", async () => {
    const name = key();
    expect((await spendFromWindow(name, 100n, 100n, WINDOW_MS, NOW)).kind).toBe(
      "allow",
    );
    expect((await spendFromWindow(name, 1n, 100n, WINDOW_MS, NOW)).kind).toBe(
      "deny",
    );

    await releaseFromWindow(name, 100n, WINDOW_MS, NOW);
    expect((await spendFromWindow(name, 100n, 100n, WINDOW_MS, NOW)).kind).toBe(
      "allow",
    );
  });

  it("never drives a counter below zero", async () => {
    const name = key();
    await spendFromWindow(name, 10n, 100n, WINDOW_MS, NOW);
    await releaseFromWindow(name, 999n, WINDOW_MS, NOW);
    // Headroom is the full cap again, not more than it.
    const after = await spendFromWindow(name, 100n, 100n, WINDOW_MS, NOW);
    expect(after.kind).toBe("allow");
    expect(after.remainingUusdc).toBe(0n);
  });
});

describe("withLock", () => {
  it("stops a read-then-write ledger from losing an update", async () => {
    // The exact double-spend shape the lock exists to prevent: the balance
    // ledger reads a whole blob, mutates it, and writes it back. Unlocked,
    // two concurrent debits both read the same starting balance and one write
    // silently drops the other, leaving money that was spent twice.
    let ledger = 1_000n;
    const spend = async (amount: bigint): Promise<void> => {
      const seen = ledger; // read
      await new Promise((resolve) => setTimeout(resolve, 5)); // yield
      if (seen < amount) return;
      ledger = seen - amount; // write
    };

    await Promise.all([
      withLock(LEDGER_LOCK, () => spend(600n)),
      withLock(LEDGER_LOCK, () => spend(600n)),
    ]);

    // Serialised: the first spend takes 600, the second sees 400 and refuses.
    // Without the lock both would read 1000 and the ledger would land on 400
    // while 1200 had actually been paid out.
    expect(ledger).toBe(400n);
  });

  it("returns the work's value and releases even when work throws", async () => {
    const ok = await withLock(LEDGER_LOCK, async () => "value");
    expect(ok).toEqual({ kind: "done", value: "value" });

    await expect(
      withLock(LEDGER_LOCK, async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");

    // The lock is free again, so a later caller is not stuck behind it.
    const after = await withLock(LEDGER_LOCK, async () => "still works");
    expect(after).toEqual({ kind: "done", value: "still works" });
  });

  it("runs locked sections one at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const work = async (): Promise<void> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3));
      inFlight -= 1;
    };

    await Promise.all(
      Array.from({ length: 8 }, () => withLock(LEDGER_LOCK, work)),
    );
    expect(maxInFlight).toBe(1);
  });
});

describe("claimOncePerWindow", () => {
  beforeEach(resetStore);

  it("allows exactly one claim per window", async () => {
    const name = key();
    expect((await claimOncePerWindow(name, WINDOW_MS, NOW)).kind).toBe("allow");
    expect((await claimOncePerWindow(name, WINDOW_MS, NOW)).kind).toBe("deny");
    expect((await claimOncePerWindow(name, WINDOW_MS, NOW + 1)).kind).toBe(
      "deny",
    );
    expect(
      (await claimOncePerWindow(name, WINDOW_MS, NOW + WINDOW_MS)).kind,
    ).toBe("allow");
  });

  it("allows exactly one of several simultaneous claims", async () => {
    const name = key();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimOncePerWindow(name, WINDOW_MS, NOW)),
    );
    expect(results.filter((r) => r.kind === "allow")).toHaveLength(1);
  });

  it("can be released when the work it guarded failed", async () => {
    const name = key();
    expect((await claimOncePerWindow(name, WINDOW_MS, NOW)).kind).toBe("allow");
    await releaseOncePerWindow(name, WINDOW_MS, NOW);
    expect((await claimOncePerWindow(name, WINDOW_MS, NOW)).kind).toBe("allow");
  });
});
