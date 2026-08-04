import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BLINK_ALLOWED_CHAIN_ID,
  BLINK_MAX_DEPOSIT_USD,
  FAUCET_COOLDOWN_MS,
  FAUCET_DAILY_BUDGET_UUSDC,
  FAUCET_GRANT_UUSDC,
  TREASURY_FLOOR_UUSDC,
  WITHDRAW_DAILY_CAP_UUSDC,
  checkBlinkDeposit,
  faucetClaimRef,
  serverFailure,
  spendVerdict,
  treasuryCanCover,
  windowBucket,
  windowRetryAfterSeconds,
} from "@/lib/money-guards";

const NOW = 1_800_000_000_000;

describe("windowBucket", () => {
  it("holds steady inside a window and advances exactly once per window", () => {
    const start = windowBucket(NOW, 60_000);
    expect(windowBucket(NOW + 59_999, 60_000)).toBe(start);
    expect(windowBucket(NOW + 60_000, 60_000)).toBe(start + 1);
  });

  it("advances by one per elapsed window regardless of alignment", () => {
    for (const offset of [0, 1, 977, 59_999]) {
      const t = NOW + offset;
      expect(windowBucket(t + FAUCET_COOLDOWN_MS, FAUCET_COOLDOWN_MS)).toBe(
        windowBucket(t, FAUCET_COOLDOWN_MS) + 1,
      );
    }
  });
});

describe("windowRetryAfterSeconds", () => {
  it("counts down to the window rollover", () => {
    const bucketStart = windowBucket(NOW, 60_000) * 60_000;
    expect(windowRetryAfterSeconds(bucketStart, 60_000)).toBe(60);
    expect(windowRetryAfterSeconds(bucketStart + 30_000, 60_000)).toBe(30);
  });

  it("never reports zero, so a Retry-After header is always actionable", () => {
    const bucketEnd = (windowBucket(NOW, 60_000) + 1) * 60_000;
    expect(windowRetryAfterSeconds(bucketEnd - 1, 60_000)).toBe(1);
  });
});

describe("faucetClaimRef", () => {
  it("is derived only from the address and the window", () => {
    // The old route keyed idempotency on a caller-supplied UUID, so a fresh
    // UUID bought a fresh credit. Same address, same window must collapse.
    expect(faucetClaimRef("0xAbC", NOW)).toBe(faucetClaimRef("0xabc", NOW + 5));
  });

  it("agrees with the rate limiter about which window a moment is in", () => {
    // The ledger ref and the per-address gate must never disagree, or one of
    // them can allow a grant the other has already counted.
    const bucket = windowBucket(NOW, FAUCET_COOLDOWN_MS);
    expect(faucetClaimRef("0xaaa", NOW)).toBe(`faucet:0xaaa:${bucket}`);
  });

  it("differs across addresses", () => {
    expect(faucetClaimRef("0xaaa", NOW)).not.toBe(faucetClaimRef("0xbbb", NOW));
  });

  it("always differs after a full window, so a valid claim is never deduped", () => {
    for (let offset = 0; offset < 5; offset += 1) {
      const t = NOW + offset * 977;
      expect(faucetClaimRef("0xaaa", t)).not.toBe(
        faucetClaimRef("0xaaa", t + FAUCET_COOLDOWN_MS),
      );
    }
  });
});

describe("spendVerdict", () => {
  const cap = 1_000n;

  it("allows an increment that lands inside the cap", () => {
    expect(spendVerdict(400n, 400n, cap)).toEqual({
      kind: "allow",
      remainingUusdc: 600n,
    });
  });

  it("allows an increment that lands exactly on the cap", () => {
    expect(spendVerdict(cap, 100n, cap)).toEqual({
      kind: "allow",
      remainingUusdc: 0n,
    });
  });

  it("denies the increment that crosses the cap and reports the remainder", () => {
    // 900 was already used, this call added 200 to reach 1100.
    expect(spendVerdict(1_100n, 200n, cap)).toEqual({
      kind: "deny",
      remainingUusdc: 100n,
    });
  });

  it("reports zero remaining once the cap is fully consumed", () => {
    expect(spendVerdict(cap + 1n, 1n, cap)).toEqual({
      kind: "deny",
      remainingUusdc: 0n,
    });
  });

  it("never reports negative headroom when the counter overshot", () => {
    // Concurrent increments can push the total well past the cap before each
    // caller reads it back; every one of them must be denied cleanly.
    expect(spendVerdict(5_000n, 100n, cap)).toEqual({
      kind: "deny",
      remainingUusdc: 0n,
    });
  });

  it("lets exactly one of several concurrent increments cross the cap", () => {
    // Simulate an atomic counter: each caller adds and reads back its own
    // post-increment total. Only the ones that stay inside the cap may pass.
    let total = 0n;
    let allowed = 0;
    for (let i = 0; i < 100; i += 1) {
      total += FAUCET_GRANT_UUSDC;
      const verdict = spendVerdict(
        total,
        FAUCET_GRANT_UUSDC,
        FAUCET_DAILY_BUDGET_UUSDC,
      );
      if (verdict.kind === "allow") allowed += 1;
    }
    expect(BigInt(allowed) * FAUCET_GRANT_UUSDC).toBe(
      FAUCET_DAILY_BUDGET_UUSDC,
    );
  });

  it("caps a single address's withdrawals at the daily limit", () => {
    expect(
      spendVerdict(
        WITHDRAW_DAILY_CAP_UUSDC,
        WITHDRAW_DAILY_CAP_UUSDC,
        WITHDRAW_DAILY_CAP_UUSDC,
      ).kind,
    ).toBe("allow");
    expect(
      spendVerdict(WITHDRAW_DAILY_CAP_UUSDC + 1n, 1n, WITHDRAW_DAILY_CAP_UUSDC)
        .kind,
    ).toBe("deny");
  });
});

describe("treasuryCanCover", () => {
  it("requires the floor to survive the transfer", () => {
    expect(treasuryCanCover(10n, 5n, 5n)).toBe(true);
    expect(treasuryCanCover(10n, 6n, 5n)).toBe(false);
  });

  it("defaults to the configured treasury floor", () => {
    expect(treasuryCanCover(TREASURY_FLOOR_UUSDC + 1n, 1n)).toBe(true);
    expect(treasuryCanCover(TREASURY_FLOOR_UUSDC, 1n)).toBe(false);
  });

  it("refuses an empty treasury outright", () => {
    expect(treasuryCanCover(0n, 1n)).toBe(false);
  });
});

describe("checkBlinkDeposit", () => {
  const limits = {
    merchantAddress: "0x1111111111111111111111111111111111111111",
    tokenAddress: "0x2222222222222222222222222222222222222222",
  };
  const ok = {
    amount: 10,
    chainId: BLINK_ALLOWED_CHAIN_ID,
    address: limits.merchantAddress,
    token: limits.tokenAddress,
  };

  it("accepts a request inside every limit", () => {
    expect(checkBlinkDeposit(ok, limits)).toBeNull();
  });

  it("is case-insensitive about address checksums", () => {
    expect(
      checkBlinkDeposit(
        {
          ...ok,
          address: limits.merchantAddress.toUpperCase().replace("0X", "0x"),
          token: limits.tokenAddress.toUpperCase().replace("0X", "0x"),
        },
        limits,
      ),
    ).toBeNull();
  });

  it("rejects an amount above the ceiling", () => {
    expect(
      checkBlinkDeposit({ ...ok, amount: BLINK_MAX_DEPOSIT_USD + 1 }, limits),
    ).toMatch(/exceed/);
    expect(checkBlinkDeposit({ ...ok, amount: 1e12 }, limits)).toMatch(
      /exceed/,
    );
  });

  it("rejects non-positive and non-finite amounts", () => {
    expect(checkBlinkDeposit({ ...ok, amount: 0 }, limits)).toMatch(/positive/);
    expect(checkBlinkDeposit({ ...ok, amount: -1 }, limits)).toMatch(
      /positive/,
    );
    expect(checkBlinkDeposit({ ...ok, amount: Number.NaN }, limits)).toMatch(
      /positive/,
    );
    expect(
      checkBlinkDeposit({ ...ok, amount: Number.POSITIVE_INFINITY }, limits),
    ).toMatch(/positive/);
  });

  it("rejects sub-cent precision", () => {
    expect(checkBlinkDeposit({ ...ok, amount: 1.005 }, limits)).toMatch(
      /cents/,
    );
    expect(checkBlinkDeposit({ ...ok, amount: 1.25 }, limits)).toBeNull();
  });

  it("rejects any chain other than Base Sepolia", () => {
    expect(checkBlinkDeposit({ ...ok, chainId: 1 }, limits)).toMatch(/chainId/);
    expect(checkBlinkDeposit({ ...ok, chainId: 5042002 }, limits)).toMatch(
      /chainId/,
    );
  });

  it("rejects any destination other than the merchant address", () => {
    expect(
      checkBlinkDeposit(
        { ...ok, address: "0x3333333333333333333333333333333333333333" },
        limits,
      ),
    ).toMatch(/merchant/);
  });

  it("rejects any token other than the configured one", () => {
    expect(
      checkBlinkDeposit(
        { ...ok, token: "0x4444444444444444444444444444444444444444" },
        limits,
      ),
    ).toMatch(/token/);
  });
});

describe("serverFailure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the raw error and returns only a correlation id", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = new Error("TREASURY_PRIVATE_KEY is malformed at rpc.example");

    const response = serverFailure("test/scope", secret);
    expect(response.status).toBe(500);

    const body = (await response.json()) as {
      error: string;
      reference: string;
    };
    expect(body.error).not.toContain("TREASURY_PRIVATE_KEY");
    expect(body.error).not.toContain("rpc.example");
    expect(body.error).toContain(body.reference);
    expect(body.reference).toMatch(/^[0-9a-f-]{36}$/);

    expect(logged).toHaveBeenCalledTimes(1);
    const [message, error] = logged.mock.calls[0];
    expect(String(message)).toContain("test/scope");
    expect(String(message)).toContain(body.reference);
    expect(error).toBe(secret);
  });

  it("honours a caller-supplied status", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      serverFailure("test/scope", new Error("nope"), { status: 502 }).status,
    ).toBe(502);
  });

  it("keeps our own message and still appends the reference", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = serverFailure("test/scope", new Error("rpc.example down"), {
      status: 502,
      message: "The transfer did not go through. Your balance was refunded.",
    });
    const body = (await response.json()) as {
      error: string;
      reference: string;
    };
    expect(body.error).toContain("Your balance was refunded.");
    expect(body.error).toContain(body.reference);
    expect(body.error).not.toContain("rpc.example");
  });
});
