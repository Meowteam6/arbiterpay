// Signatures here are produced by real viem keys, not fixtures pasted from a
// previous run: the whole value of this guard is that it accepts exactly what
// a wallet produces and nothing else, so the test has to sign the same way a
// wallet does.
import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import {
  WALLET_AUTH_ADDRESS_HEADER,
  WALLET_AUTH_MAX_AGE_MS,
  WALLET_AUTH_MAX_SKEW_MS,
  WALLET_AUTH_SIGNATURE_HEADER,
  WALLET_AUTH_TIMESTAMP_HEADER,
  authenticateWallet,
  readWalletAuthHeaders,
  requireAddressSignature,
  verifyWalletSignature,
  walletAuthMessage,
} from "@/lib/server/wallet-auth";

const OWNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const STRANGER = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);

const NOW = Date.parse("2026-08-04T12:00:00.000Z");

async function sign(
  account: typeof OWNER,
  addressInMessage: string,
  timestamp: string,
): Promise<string> {
  return account.signMessage({
    message: walletAuthMessage(addressInMessage, timestamp),
  });
}

function request(headers: Record<string, string>, url = "https://x/api/t"): Request {
  return new Request(url, { headers });
}

describe("walletAuthMessage", () => {
  it("names both the address and the instant", () => {
    expect(walletAuthMessage("0xAbC", "2026-08-04T12:00:00.000Z")).toBe(
      "GoHealthMe: prove control of 0xAbC at 2026-08-04T12:00:00.000Z",
    );
  });
});

describe("verifyWalletSignature", () => {
  it("accepts a fresh signature from the address owner", async () => {
    const timestamp = new Date(NOW).toISOString();
    const signature = await sign(OWNER, OWNER.address, timestamp);

    const result = await verifyWalletSignature({
      address: OWNER.address,
      timestamp,
      signature,
      now: NOW,
    });

    expect(result).toEqual({ ok: true, address: getAddress(OWNER.address) });
  });

  it("accepts a signature over the lowercased address form", async () => {
    const timestamp = new Date(NOW).toISOString();
    const signature = await sign(
      OWNER,
      OWNER.address.toLowerCase(),
      timestamp,
    );

    const result = await verifyWalletSignature({
      address: OWNER.address.toLowerCase(),
      timestamp,
      signature,
      now: NOW,
    });

    expect(result.ok).toBe(true);
  });

  it("returns the checksummed address whatever case was claimed", async () => {
    const timestamp = new Date(NOW).toISOString();
    const signature = await sign(OWNER, OWNER.address, timestamp);

    const result = await verifyWalletSignature({
      address: OWNER.address.toLowerCase(),
      timestamp,
      signature,
      now: NOW,
    });

    expect(result).toEqual({ ok: true, address: getAddress(OWNER.address) });
  });

  it("rejects a signature made by a different key", async () => {
    // The stranger signs the owner's message verbatim: the message is public,
    // so only key control can distinguish them.
    const timestamp = new Date(NOW).toISOString();
    const signature = await sign(STRANGER, OWNER.address, timestamp);

    const result = await verifyWalletSignature({
      address: OWNER.address,
      timestamp,
      signature,
      now: NOW,
    });

    expect(result).toEqual({
      ok: false,
      reason: "signature does not match the claimed address",
    });
  });

  it("rejects a signature over a different timestamp than the header claims", async () => {
    const signedAt = new Date(NOW - 5_000).toISOString();
    const claimedAt = new Date(NOW).toISOString();
    const signature = await sign(OWNER, OWNER.address, signedAt);

    const result = await verifyWalletSignature({
      address: OWNER.address,
      timestamp: claimedAt,
      signature,
      now: NOW,
    });

    expect(result.ok).toBe(false);
  });

  it("accepts a signature just inside the freshness window", async () => {
    const timestamp = new Date(NOW - WALLET_AUTH_MAX_AGE_MS + 1_000).toISOString();
    const signature = await sign(OWNER, OWNER.address, timestamp);

    const result = await verifyWalletSignature({
      address: OWNER.address,
      timestamp,
      signature,
      now: NOW,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a signature past the freshness window", async () => {
    const timestamp = new Date(NOW - WALLET_AUTH_MAX_AGE_MS - 1_000).toISOString();
    const signature = await sign(OWNER, OWNER.address, timestamp);

    const result = await verifyWalletSignature({
      address: OWNER.address,
      timestamp,
      signature,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("expired");
  });

  it("tolerates small clock skew into the future", async () => {
    const timestamp = new Date(NOW + WALLET_AUTH_MAX_SKEW_MS - 1_000).toISOString();
    const signature = await sign(OWNER, OWNER.address, timestamp);

    const result = await verifyWalletSignature({
      address: OWNER.address,
      timestamp,
      signature,
      now: NOW,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a timestamp far in the future, which would extend the replay window", async () => {
    const timestamp = new Date(NOW + 60 * 60 * 1000).toISOString();
    const signature = await sign(OWNER, OWNER.address, timestamp);

    const result = await verifyWalletSignature({
      address: OWNER.address,
      timestamp,
      signature,
      now: NOW,
    });

    expect(result).toEqual({
      ok: false,
      reason: "signature timestamp is in the future",
    });
  });

  it("rejects a non-date timestamp", async () => {
    const result = await verifyWalletSignature({
      address: OWNER.address,
      timestamp: "yesterday",
      signature: `0x${"11".repeat(65)}`,
      now: NOW,
    });

    expect(result).toEqual({
      ok: false,
      reason: "timestamp header is not an ISO-8601 date",
    });
  });

  it("rejects a malformed signature without throwing", async () => {
    const timestamp = new Date(NOW).toISOString();

    await expect(
      verifyWalletSignature({
        address: OWNER.address,
        timestamp,
        signature: "not-hex",
        now: NOW,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "signature header is not 0x hex",
    });
  });

  it("rejects hex that is the wrong length for a signature", async () => {
    const timestamp = new Date(NOW).toISOString();

    const result = await verifyWalletSignature({
      address: OWNER.address,
      timestamp,
      signature: "0xdeadbeef",
      now: NOW,
    });

    expect(result.ok).toBe(false);
  });

  it("rejects an address that is not an address", async () => {
    const result = await verifyWalletSignature({
      address: "0xnope",
      timestamp: new Date(NOW).toISOString(),
      signature: `0x${"11".repeat(65)}`,
      now: NOW,
    });

    expect(result).toEqual({
      ok: false,
      reason: "address header is not a valid 0x address",
    });
  });
});

describe("readWalletAuthHeaders", () => {
  it("returns null when any header is missing", () => {
    expect(
      readWalletAuthHeaders(
        request({
          [WALLET_AUTH_ADDRESS_HEADER]: OWNER.address,
          [WALLET_AUTH_TIMESTAMP_HEADER]: new Date(NOW).toISOString(),
        }),
      ),
    ).toBeNull();
  });

  it("returns null when a header is present but empty", () => {
    expect(
      readWalletAuthHeaders(
        request({
          [WALLET_AUTH_ADDRESS_HEADER]: OWNER.address,
          [WALLET_AUTH_TIMESTAMP_HEADER]: new Date(NOW).toISOString(),
          [WALLET_AUTH_SIGNATURE_HEADER]: "   ",
        }),
      ),
    ).toBeNull();
  });

  it("trims the values it returns", () => {
    const timestamp = new Date(NOW).toISOString();
    expect(
      readWalletAuthHeaders(
        request({
          [WALLET_AUTH_ADDRESS_HEADER]: ` ${OWNER.address} `,
          [WALLET_AUTH_TIMESTAMP_HEADER]: ` ${timestamp} `,
          [WALLET_AUTH_SIGNATURE_HEADER]: " 0xabc ",
        }),
      ),
    ).toEqual({
      address: OWNER.address,
      timestamp,
      signature: "0xabc",
    });
  });
});

describe("authenticateWallet", () => {
  it("names the missing headers so an unwired client is obvious", async () => {
    const result = await authenticateWallet(request({}), NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(
      WALLET_AUTH_SIGNATURE_HEADER,
    );
  });

  it("authenticates a correctly signed request", async () => {
    const timestamp = new Date(NOW).toISOString();
    const signature = await sign(OWNER, OWNER.address, timestamp);

    const result = await authenticateWallet(
      request({
        [WALLET_AUTH_ADDRESS_HEADER]: OWNER.address,
        [WALLET_AUTH_TIMESTAMP_HEADER]: timestamp,
        [WALLET_AUTH_SIGNATURE_HEADER]: signature,
      }),
      NOW,
    );

    expect(result).toEqual({ ok: true, address: getAddress(OWNER.address) });
  });
});

describe("requireAddressSignature", () => {
  it("accepts when the signature proves the requested address", async () => {
    const timestamp = new Date(NOW).toISOString();
    const signature = await sign(OWNER, OWNER.address, timestamp);

    const result = await requireAddressSignature(
      request({
        [WALLET_AUTH_ADDRESS_HEADER]: OWNER.address,
        [WALLET_AUTH_TIMESTAMP_HEADER]: timestamp,
        [WALLET_AUTH_SIGNATURE_HEADER]: signature,
      }),
      OWNER.address,
      NOW,
    );

    expect(result).toEqual({ ok: true, address: getAddress(OWNER.address) });
  });

  it("accepts regardless of the case the requested address is written in", async () => {
    const timestamp = new Date(NOW).toISOString();
    const signature = await sign(OWNER, OWNER.address, timestamp);

    const result = await requireAddressSignature(
      request({
        [WALLET_AUTH_ADDRESS_HEADER]: OWNER.address,
        [WALLET_AUTH_TIMESTAMP_HEADER]: timestamp,
        [WALLET_AUTH_SIGNATURE_HEADER]: signature,
      }),
      OWNER.address.toLowerCase(),
      NOW,
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a valid signature aimed at somebody else's address", async () => {
    // The exact attack the junction routes were open to: sign for your own
    // wallet, then ask for a stranger's health summary in the query string.
    const timestamp = new Date(NOW).toISOString();
    const signature = await sign(STRANGER, STRANGER.address, timestamp);

    const result = await requireAddressSignature(
      request({
        [WALLET_AUTH_ADDRESS_HEADER]: STRANGER.address,
        [WALLET_AUTH_TIMESTAMP_HEADER]: timestamp,
        [WALLET_AUTH_SIGNATURE_HEADER]: signature,
      }),
      OWNER.address,
      NOW,
    );

    expect(result).toEqual({
      ok: false,
      reason: "signature proves control of a different address",
    });
  });

  it("refuses when the requested address is malformed", async () => {
    const timestamp = new Date(NOW).toISOString();
    const signature = await sign(OWNER, OWNER.address, timestamp);

    const result = await requireAddressSignature(
      request({
        [WALLET_AUTH_ADDRESS_HEADER]: OWNER.address,
        [WALLET_AUTH_TIMESTAMP_HEADER]: timestamp,
        [WALLET_AUTH_SIGNATURE_HEADER]: signature,
      }),
      "0xnope",
      NOW,
    );

    expect(result).toEqual({
      ok: false,
      reason: "requested address is not a valid 0x address",
    });
  });

  it("refuses an unsigned request", async () => {
    const result = await requireAddressSignature(
      request({}),
      OWNER.address,
      NOW,
    );
    expect(result.ok).toBe(false);
  });
});
