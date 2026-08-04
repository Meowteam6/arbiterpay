"use client";

// Client-side non-custodial Unlink account derivation.
// Each user's Unlink identity is derived deterministically from their own
// wallet signature — no server holds their private keys.
//
// AUTH WIRING: /api/unlink/authorization-token and /api/unlink/register are
// signature-gated server-side (lib/server/unlink-admin.ts). A capability token
// is the key to somebody's shielded balance and history, and it is requested
// by wallet address — a public value — so the routes refuse an unsigned
// caller. The SDK calls them with its own fetch, which is why the proof has to
// go in through `customFetch`; without this the whole private-payout flow
// answers 401.
//
// The same customFetch is also used for the Unlink Engine's own host, so the
// headers are attached to same-origin requests ONLY (see client-auth.ts). A
// wallet-control proof is a bearer credential for its lifetime and belongs to
// this app's routes, not to a third party.
import {
  account as unlinkAccountNs,
  createUnlinkClient,
  type UnlinkClient,
} from "@unlink-xyz/sdk/browser";
import type { ArcWalletClient } from "@/lib/wallet";
import { getWalletAuth, walletAuthFetch } from "@/lib/client-auth";

/** ARC Testnet chain id — must match the value used in account derivation. */
const ARC_CHAIN_ID = 5042002;

/**
 * Fixed message signed by the user's wallet to derive their Unlink seed.
 * MUST NOT change once deployed — changing it derives a different Unlink
 * address and the user loses access to any existing shielded balance.
 */
const UNLINK_DERIVATION_MESSAGE = "GoHealthMe Unlink account v1";

/** Re-exported so browser components don't need to import from server files. */
export const ARC_USDC_ADDRESS =
  "0x3600000000000000000000000000000000000000";

export interface DerivedUnlinkAccount {
  client: UnlinkClient;
  unlinkAddress: string;
}

/**
 * Derive a non-custodial Unlink account from the user's viem WalletClient.
 *
 * 1. Signs a fixed deterministic message (no pop-up storm on re-derive).
 * 2. Derives the Unlink account from the signature (synchronous, pure).
 * 3. Proves control of the wallet to our own capability routes.
 * 4. Constructs a browser UnlinkClient pointing at those routes.
 * 5. Registers the account with the engine (idempotent — safe to call again).
 * 6. Returns the client + the bech32m unlink address for the payout POST.
 *
 * Two signatures, deliberately: the derivation message is a fixed string that
 * must never change (it IS the account), and the auth message carries a
 * timestamp so it expires. Conflating them would either make the account
 * un-derivable or the credential immortal. The second one is cached for the
 * session, so a return visit prompts once, not twice.
 */
export async function deriveUnlinkAccount(
  walletClient: ArcWalletClient,
): Promise<DerivedUnlinkAccount> {
  const appId = process.env.NEXT_PUBLIC_UNLINK_APP_ID;
  if (!appId) {
    throw new Error(
      "NEXT_PUBLIC_UNLINK_APP_ID is not set. Add it to app/.env.local.",
    );
  }

  // Step 1: sign the derivation message with the user's own wallet.
  const signature = await walletClient.signMessage({
    account: walletClient.account,
    message: UNLINK_DERIVATION_MESSAGE,
  });

  // Step 2: derive the Unlink account (synchronous).
  const localAccount = unlinkAccountNs.fromEthereumSignature({
    signature,
    appId,
    chainId: ARC_CHAIN_ID,
  });

  // Step 3: prove control of the wallet to our own routes. Failure is loud:
  // registering or minting a token without it returns 401, and a payout flow
  // that limps on from here would fail later with a worse message.
  //
  // The requester (not the credential) is what the client keeps: this client
  // outlives one signature's ten minute window and mints capability tokens on
  // its own schedule, so it re-reads the cache per request and signs again
  // only when there is nothing usable left.
  const requestAuth = () =>
    getWalletAuth({
      address: walletClient.account.address,
      signMessage: (message) =>
        walletClient.signMessage({ account: walletClient.account, message }),
    });
  const auth = await requestAuth();
  if (auth.kind !== "ok") {
    throw new Error(
      auth.kind === "declined"
        ? "Private payouts need a signature proving this wallet is yours. Nothing is charged and no transaction is sent."
        : `Could not prove control of this wallet for private payouts (${auth.kind}).`,
    );
  }

  // Step 4: construct the browser client.
  // Uses DEFAULT_AUTHORIZATION_TOKEN_URL (/api/unlink/authorization-token) and
  // DEFAULT_REGISTER_URL (/api/unlink/register) automatically.
  const client = createUnlinkClient({
    environment: "arc-testnet",
    account: localAccount,
    customFetch: walletAuthFetch(requestAuth, window.location.origin),
  });

  // Step 5: register (idempotent — safe to call on every page load).
  await client.ensureRegistered();

  // Step 6: resolve the user's bech32m Unlink address.
  const unlinkAddress = await client.getAddress();

  return { client, unlinkAddress };
}
