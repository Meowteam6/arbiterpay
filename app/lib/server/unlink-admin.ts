// Server-side Unlink admin handle + auth route handlers for 0.3.0 SDK.
// The admin handle issues short-lived capability tokens and registers users.
// Auth routes are mounted at /api/unlink/authorization-token and /api/unlink/register.
//
// WHY THE AUTH HOOKS ARE REAL NOW: this file used to pass
// `authenticate: async () => ({})` and `authorizeUnlinkAddress: async () => true`,
// which meant any caller could obtain a capability token scoped to any user's
// shielded Unlink address. That token is the key to the private-payments layer
// — balances and transaction history included — so the effect was that the
// privacy guarantee held against everyone except whoever bothered to POST. The
// comment claiming access was "implicitly scoped by appId + engine
// environment" was wrong: the appId is a public client value and the engine
// scopes to the project, not to the user.
//
// The replacement is two checks:
//
//   1. authenticate       — the caller signs a fresh message with their wallet
//                           (lib/server/wallet-auth.ts). Proves who they are.
//   2. authorizeUnlinkAddress — the requested Unlink address must be the one
//                           bound to that wallet. Proves it is theirs.
//
// HOW THE BINDING GETS CREATED: `onRegister` fires after Engine accepts a
// registration and records the wallet -> Unlink address binding. The browser
// derives its Unlink account from a wallet signature and calls
// `ensureRegistered()` before ever asking for a token (lib/unlink/browser.ts),
// and registration is idempotent, so the binding is (re)written on every page
// load and is always in place before step 2 runs.
//
// WHY THERE IS A SECOND, SEPARATE BINDING LEDGER: claims.ts's map cannot be
// used on its own as an ownership oracle, because it is not written only by
// authenticated code. /api/unlink/payout calls `linkUnlinkAddress(address,
// unlinkAddress)` with both values taken straight from an unauthenticated
// request body, gated only on the CALLER's own pool membership and verdict.
// Anyone who legitimately completes one claim can therefore write
// `their wallet -> somebody else's Unlink address` into that map. Trusting it
// here would turn a stale demo shortcut into a capability token for a
// stranger's shielded balance. The ledger below is written in exactly one
// place — `onRegister`, behind a verified wallet signature AND an Engine
// registration that required the account's own viewing/nullifying key
// material — and both must agree before a token is issued.
//
// CLIENT WIRING (needed for the browser SDK to reach these routes): the SDK
// posts to DEFAULT_AUTHORIZATION_TOKEN_URL and DEFAULT_REGISTER_URL with its
// own fetch, so the three wallet-auth headers must be attached through
// `createUnlinkClient({ customFetch })`. Until that lands the Unlink flow
// answers 401 rather than handing tokens to anyone, which is the correct
// direction to fail.

import {
  createUnlinkAdmin,
  createUnlinkAuthRoutes,
  type UnlinkAuthRouteHandlers,
} from "@unlink-xyz/sdk/admin";
import { getAddress, type Address } from "viem";
import { requireEnv, optionalEnv } from "@/lib/server/env";
import { readJson, writeJson } from "@/lib/server/store";
import { authenticateWallet } from "@/lib/server/wallet-auth";
import { linkUnlinkAddress, userOwnsUnlinkAddress } from "@/lib/server/claims";

/**
 * 0.3.0 requires EXACTLY ONE of `engineUrl` or `environment`. Prefer an
 * explicit UNLINK_ENGINE_URL when set, otherwise fall back to the named
 * environment (which the SDK resolves to its engine URL internally).
 */
export function unlinkEndpoint():
  | { engineUrl: string }
  | { environment: string } {
  const engineUrl = process.env.UNLINK_ENGINE_URL?.trim();
  if (engineUrl) return { engineUrl };
  return { environment: optionalEnv("UNLINK_ENVIRONMENT", "arc-testnet") };
}

function unlinkAdmin() {
  return createUnlinkAdmin({
    ...unlinkEndpoint(),
    apiKey: requireEnv("UNLINK_API_KEY"),
  });
}

/** What `authenticate` proved, carried through to the other hooks. */
interface UnlinkSession {
  readonly address: Address;
}

/**
 * Is this Unlink address bound to this wallet?
 *
 * Both the checksummed and the lowercased wallet key are checked. The mapping
 * is a plain key/value store and /api/unlink/payout writes it under whatever
 * casing the client sent, so matching on one form only would silently fail to
 * authorize a legitimate owner. Both forms name the same wallet, so trying
 * both cannot authorize anyone who is not already the owner.
 */
async function walletOwnsUnlinkAddress(
  wallet: Address,
  unlinkAddress: string,
): Promise<boolean> {
  if (await userOwnsUnlinkAddress(wallet, unlinkAddress)) return true;
  return userOwnsUnlinkAddress(wallet.toLowerCase(), unlinkAddress);
}

// ------------------------------------------------- authenticated binding ledger

const BINDING_FILE = "unlink-auth-bindings.json";

/**
 * Two indexes over the same facts. `byUnlink` is what makes takeover
 * impossible rather than merely unlikely: without it there is no way to notice
 * that an Unlink address is already spoken for.
 */
interface AuthenticatedBindings {
  /** lowercased wallet -> Unlink address */
  byWallet: Record<string, string>;
  /** Unlink address -> lowercased wallet */
  byUnlink: Record<string, string>;
}

/**
 * Always returns freshly built objects. A shared fallback constant would be
 * handed back by reference on every miss and then mutated by the writer below,
 * so a long-lived process would accumulate bindings in memory that outlive the
 * store — authorizing wallets against a record that no longer exists.
 */
async function readBindings(): Promise<AuthenticatedBindings> {
  const stored = await readJson<Partial<AuthenticatedBindings> | null>(
    BINDING_FILE,
    null,
  );
  return {
    byWallet: { ...(stored?.byWallet ?? {}) },
    byUnlink: { ...(stored?.byUnlink ?? {}) },
  };
}

/**
 * Record that `wallet` proved control of `unlinkAddress`, first writer wins.
 *
 * An Unlink address is derived from the owner's own wallet signature, so
 * nobody can compute somebody else's address in advance; by the time an
 * address is observable at all, its owner has already registered it. Refusing
 * to move an existing binding to a different wallet therefore closes takeover
 * outright, and it does so loudly: the conflict throws rather than quietly
 * leaving the caller with a working registration and no binding.
 */
export async function bindWalletToUnlinkAddress(
  wallet: Address,
  unlinkAddress: string,
): Promise<void> {
  const walletKey = wallet.toLowerCase();
  const bindings = await readBindings();

  const currentOwner = bindings.byUnlink[unlinkAddress];
  if (currentOwner !== undefined && currentOwner !== walletKey) {
    console.error("[unlink-admin] refusing to rebind an Unlink address", {
      unlinkAddress,
      currentOwner,
      requestedBy: walletKey,
    });
    throw new Error("unlink address is already bound to a different wallet");
  }

  // A wallet may move to a new Unlink address (a new appId derives a new
  // account); drop the stale reverse entry so it cannot authorize anyone.
  const previous = bindings.byWallet[walletKey];
  if (previous !== undefined && previous !== unlinkAddress) {
    delete bindings.byUnlink[previous];
  }

  if (previous === unlinkAddress && currentOwner === walletKey) return;

  bindings.byWallet[walletKey] = unlinkAddress;
  bindings.byUnlink[unlinkAddress] = walletKey;
  await writeJson(BINDING_FILE, bindings);
}

/** Did this exact wallet register this exact Unlink address? */
export async function hasAuthenticatedBinding(
  wallet: Address,
  unlinkAddress: string,
): Promise<boolean> {
  const bindings = await readBindings();
  return bindings.byWallet[wallet.toLowerCase()] === unlinkAddress;
}

export function unlinkAuthRoutes(): UnlinkAuthRouteHandlers {
  const admin = unlinkAdmin();
  return createUnlinkAuthRoutes<UnlinkSession>({
    admin,
    // Throwing is how the SDK is told to answer 401. The message is consumed
    // by the SDK, not composed by us, so it must stay free of internals.
    authenticate: async (request: Request) => {
      const auth = await authenticateWallet(request);
      if (!auth.ok) {
        throw new Error(`wallet signature required: ${auth.reason}`);
      }
      return { address: auth.address };
    },
    // Both ledgers must agree. The authenticated one is the security boundary;
    // the claims map is kept in the check so the two cannot silently diverge.
    authorizeUnlinkAddress: async ({ session, unlinkAddress }) => {
      if (!(await hasAuthenticatedBinding(session.address, unlinkAddress))) {
        return false;
      }
      return walletOwnsUnlinkAddress(session.address, unlinkAddress);
    },
    onRegister: async ({ session, registration }) => {
      // Bind wallet -> Unlink address the moment Engine accepts the
      // registration. Without this write the very first token request for a
      // freshly derived account would have nothing to authorize against.
      // The authenticated ledger is written first: if it rejects the binding
      // the claims map must not be updated either.
      await bindWalletToUnlinkAddress(session.address, registration.address);
      await linkUnlinkAddress(getAddress(session.address), registration.address);
    },
  });
}

export { unlinkAdmin };
