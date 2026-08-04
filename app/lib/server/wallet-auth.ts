// Proof that the caller controls a wallet address, from an EIP-191 signature.
//
// WHY THIS EXISTS: a wallet address is public. It appears on chain, in pool
// participant lists, and in the app's own UI. Several routes treated it as if
// it were a secret and returned that address's private data to anyone who
// typed it — per-day sleep scores and activity summaries from
// /api/junction/*, and an Unlink capability token scoped to any user's
// shielded address from /api/unlink/*. Knowing an address must not be the same
// thing as being its owner, and this module is where that gap is closed.
//
// THE PROOF. The caller signs a message that names the address and the moment:
//
//   GoHealthMe: prove control of <address> at <ISO-8601 timestamp>
//
// and sends three headers alongside the request:
//
//   x-gohealthme-address    the 0x address being claimed
//   x-gohealthme-timestamp  the exact ISO-8601 string used in the message
//   x-gohealthme-signature  the 0x EIP-191 signature over that message
//
// The server rebuilds the message from the address and timestamp headers and
// verifies the signature against the claimed address. Nothing is stored, so
// there is no session table to leak and no logout to get wrong.
//
// REPLAY. A signature is a bearer credential for as long as it verifies, so
// the message carries a timestamp and anything older than WALLET_AUTH_MAX_AGE_MS
// is refused. That bounds a stolen header set to a ten minute window rather
// than forever. A small amount of future skew is tolerated because client
// clocks drift; large future timestamps are refused because they would extend
// the replay window at the caller's discretion. This is deliberately not a
// nonce ledger: a nonce store would need shared state on every read route and
// buys little against an attacker who can already read the victim's headers.
//
// SIGNER SUPPORT. Verification is offline EOA recovery. Dynamic's embedded
// wallets sign as EOAs, so this covers the app's users. Smart-contract wallets
// (ERC-1271) would need an RPC round trip per request; adding that is a
// deliberate future change, not an accident of this one.
//
// USED BY: lib/server/unlink-admin.ts (capability token issuance) and the two
// /api/junction/* routes. It is intentionally NOT used on the claim path
// (/api/agent/run, /api/evidence/submit) — those are idempotent, spend-capped,
// and gated on the attester verdict rather than on the caller.

import { getAddress, isAddress, verifyMessage, type Address } from "viem";

export const WALLET_AUTH_ADDRESS_HEADER = "x-gohealthme-address";
export const WALLET_AUTH_TIMESTAMP_HEADER = "x-gohealthme-timestamp";
export const WALLET_AUTH_SIGNATURE_HEADER = "x-gohealthme-signature";

/** How long a signature stays usable. Ten minutes covers a slow user, not a leak. */
export const WALLET_AUTH_MAX_AGE_MS = 10 * 60 * 1000;

/** Tolerated client clock drift into the future. */
export const WALLET_AUTH_MAX_SKEW_MS = 60 * 1000;

/**
 * The exact string the wallet must sign. Any change here invalidates every
 * signature in flight, so treat it as a wire format.
 */
export function walletAuthMessage(address: string, isoTimestamp: string): string {
  return `GoHealthMe: prove control of ${address} at ${isoTimestamp}`;
}

export type WalletAuth =
  | { ok: true; address: Address }
  | { ok: false; reason: string };

export interface WalletAuthHeaders {
  address: string;
  timestamp: string;
  signature: string;
}

/**
 * Pull the three headers off a request. Returns null when any is absent, which
 * the callers report as "no signature supplied" rather than "bad signature" —
 * an unsigned request is a client that has not been wired up yet, not an
 * attack.
 */
export function readWalletAuthHeaders(
  request: Request,
): WalletAuthHeaders | null {
  const address = request.headers.get(WALLET_AUTH_ADDRESS_HEADER)?.trim();
  const timestamp = request.headers.get(WALLET_AUTH_TIMESTAMP_HEADER)?.trim();
  const signature = request.headers.get(WALLET_AUTH_SIGNATURE_HEADER)?.trim();
  if (
    address === undefined ||
    address === "" ||
    timestamp === undefined ||
    timestamp === "" ||
    signature === undefined ||
    signature === ""
  ) {
    return null;
  }
  return { address, timestamp, signature };
}

/**
 * Verify a signature over the deterministic message for (address, timestamp).
 *
 * Both the checksummed and the lowercased rendering of the address are
 * accepted. They bind the identical claim — same address, same instant — so
 * accepting both costs nothing in strength and removes the single most likely
 * integration bug, a client that happens to hold the address in the other
 * case. The returned address is always checksummed, so callers get one form.
 */
export async function verifyWalletSignature(params: {
  address: string;
  timestamp: string;
  signature: string;
  now?: number;
}): Promise<WalletAuth> {
  const { address, timestamp, signature } = params;
  const now = params.now ?? Date.now();

  if (!isAddress(address)) {
    return { ok: false, reason: "address header is not a valid 0x address" };
  }
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    return { ok: false, reason: "signature header is not 0x hex" };
  }

  const signedAtMs = Date.parse(timestamp);
  if (!Number.isFinite(signedAtMs)) {
    return { ok: false, reason: "timestamp header is not an ISO-8601 date" };
  }
  const ageMs = now - signedAtMs;
  if (ageMs > WALLET_AUTH_MAX_AGE_MS) {
    return {
      ok: false,
      reason: `signature expired (older than ${WALLET_AUTH_MAX_AGE_MS / 60000} minutes)`,
    };
  }
  if (ageMs < -WALLET_AUTH_MAX_SKEW_MS) {
    return { ok: false, reason: "signature timestamp is in the future" };
  }

  const checksummed = getAddress(address);
  const candidates = [
    walletAuthMessage(checksummed, timestamp),
    walletAuthMessage(address.toLowerCase(), timestamp),
  ];

  for (const message of candidates) {
    let valid = false;
    try {
      valid = await verifyMessage({
        address: checksummed,
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      // A malformed signature makes viem throw rather than return false. Both
      // mean the same thing to the caller, so fall through to the next
      // candidate and, failing that, the generic rejection below.
      valid = false;
    }
    if (valid) return { ok: true, address: checksummed };
  }

  return { ok: false, reason: "signature does not match the claimed address" };
}

/**
 * Authenticate a request from its headers alone. The address is whatever the
 * caller claims and proves, which is what the Unlink auth routes need: the
 * request body there is the SDK's, not ours.
 */
export async function authenticateWallet(
  request: Request,
  now?: number,
): Promise<WalletAuth> {
  const headers = readWalletAuthHeaders(request);
  if (headers === null) {
    return {
      ok: false,
      reason:
        `missing wallet signature headers (${WALLET_AUTH_ADDRESS_HEADER}, ` +
        `${WALLET_AUTH_TIMESTAMP_HEADER}, ${WALLET_AUTH_SIGNATURE_HEADER})`,
    };
  }
  return verifyWalletSignature({ ...headers, now });
}

/**
 * Guard for routes that already know which address the request is about: the
 * signature must prove control of THAT address, not merely of some address.
 * Without this check a caller could sign for their own wallet and then ask for
 * somebody else's data in the query string.
 */
export async function requireAddressSignature(
  request: Request,
  address: string,
  now?: number,
): Promise<WalletAuth> {
  const auth = await authenticateWallet(request, now);
  if (!auth.ok) return auth;

  if (!isAddress(address)) {
    return { ok: false, reason: "requested address is not a valid 0x address" };
  }
  if (auth.address !== getAddress(address)) {
    return {
      ok: false,
      reason: "signature proves control of a different address",
    };
  }
  return auth;
}
