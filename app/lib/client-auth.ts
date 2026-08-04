// Browser side of the wallet-signature proof that lib/server/wallet-auth.ts
// verifies.
//
// WHY THIS EXISTS: a goalId is not a capability. The public feed publishes
// them and pool participants are readable on chain, so possession of one
// proves nothing about who is asking. The only thing that separates the person
// whose medical document was judged from a stranger who copied their goal id
// is a signature from that wallet, and this module is where the browser
// produces one.
//
// WHY IT CACHES. The claim loop polls the run route every 800ms. A wallet
// prompt per poll would be unusable, so a signature is signed once and reused
// until it ages out. The credential lives in module memory only - never
// localStorage, never a cookie: it is a bearer credential for its whole
// lifetime, and one that dies with the tab cannot be lifted off disk later.
//
// WHY THE WINDOW IS SHORTER THAN THE SERVER'S. The server refuses anything
// older than ten minutes measured against ITS clock. Reusing a credential for
// the full ten would mean a browser whose clock runs slow starts getting 401s
// at the boundary; the margin below absorbs that. When a 401 arrives anyway,
// fetchWithWalletAuth drops the cached credential and signs once more rather
// than reporting a permission problem the user cannot act on.
//
// WHY THE MESSAGE IS MIRRORED, NOT IMPORTED: walletAuthMessage lives in
// lib/server/wallet-auth.ts, and server modules stay out of the client bundle
// (the same rule agent-receipt.ts and claim-restore.ts follow). The two
// renderings are pinned to each other by a test that imports both, so drift
// fails the suite rather than the login.

export const WALLET_AUTH_ADDRESS_HEADER = "x-gohealthme-address";
export const WALLET_AUTH_TIMESTAMP_HEADER = "x-gohealthme-timestamp";
export const WALLET_AUTH_SIGNATURE_HEADER = "x-gohealthme-signature";

/** How long a signed credential is reused. The server allows ten minutes;
 *  the two-minute margin covers client clock drift and a slow request. */
export const CLIENT_WALLET_AUTH_TTL_MS = 8 * 60 * 1000;

/** Mirror of lib/server/wallet-auth.ts's walletAuthMessage. Wire format. */
export function clientWalletAuthMessage(
  address: string,
  isoTimestamp: string,
): string {
  return `GoHealthMe: prove control of ${address} at ${isoTimestamp}`;
}

export interface WalletAuthCredential {
  address: string;
  timestamp: string;
  signature: string;
}

/** The three headers the server reads. */
export function authHeadersOf(
  credential: WalletAuthCredential,
): Record<string, string> {
  return {
    [WALLET_AUTH_ADDRESS_HEADER]: credential.address,
    [WALLET_AUTH_TIMESTAMP_HEADER]: credential.timestamp,
    [WALLET_AUTH_SIGNATURE_HEADER]: credential.signature,
  };
}

/**
 * Whether a cached credential may still be sent for `address`. Address match
 * is case-insensitive because the connected wallet and the cache may hold
 * different renderings of the same account; freshness is measured from the
 * moment it was signed. A credential signed in the future (the clock moved
 * backwards mid-session) is treated as unusable rather than as valid forever.
 */
export function credentialUsableAt(
  credential: WalletAuthCredential,
  address: string,
  nowMs: number,
): boolean {
  if (credential.address.toLowerCase() !== address.toLowerCase()) return false;
  const signedAtMs = Date.parse(credential.timestamp);
  if (!Number.isFinite(signedAtMs)) return false;
  const ageMs = nowMs - signedAtMs;
  return ageMs >= 0 && ageMs < CLIENT_WALLET_AUTH_TTL_MS;
}

export type ClientAuth =
  /** Signed and fresh; `headers` goes straight onto a fetch. */
  | { kind: "ok"; credential: WalletAuthCredential; headers: Record<string, string> }
  /** No wallet connected, so there is nobody to prove control of. */
  | { kind: "no-wallet" }
  /** Nothing cached and the caller asked not to prompt. Browse surfaces read
   *  this way: a page nobody asked to unlock must not throw up a wallet
   *  modal, so it reads what it can and says the rest is behind a signature. */
  | { kind: "unsigned" }
  /** The user saw the prompt and said no. */
  | { kind: "declined" }
  /** The signer failed for some other reason (wrong network, SDK error). */
  | { kind: "failed"; message: string };

/**
 * User-facing sentence for an auth attempt that produced no credential. Lives
 * here so every surface says the same true thing, and so the wording is
 * testable in node alongside the branch that selects it. Returns null for a
 * successful attempt.
 */
export function authBlockReason(auth: ClientAuth): string | null {
  switch (auth.kind) {
    case "ok":
      return null;
    case "no-wallet":
      return "Connect your wallet to see this claim. It is private to the wallet that made it.";
    case "unsigned":
      return "This is private to your wallet. Sign to unlock it - nothing is charged and no transaction is sent.";
    case "declined":
      return "This claim is private to your wallet, so it stays hidden until you sign. Nothing is charged and no transaction is sent - the signature only proves the wallet is yours.";
    case "failed":
      return `Your wallet could not sign the proof of ownership: ${auth.message}`;
  }
}

/** viem, Dynamic and injected wallets all report a refused prompt differently.
 *  Rejection is not an error to report as a failure - it is a choice, and the
 *  copy for it is different - so it is classified rather than lumped in. */
export function isUserRejection(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { name?: unknown; code?: unknown; message?: unknown };
  if (candidate.code === 4001) return true;
  if (
    typeof candidate.name === "string" &&
    /UserRejected|UserDenied/i.test(candidate.name)
  ) {
    return true;
  }
  return (
    typeof candidate.message === "string" &&
    /user (rejected|denied)|rejected the request|denied (the )?(message|signature)/i.test(
      candidate.message,
    )
  );
}

export type SignMessageFn = (message: string) => Promise<string>;

// ------------------------------------------------------------------ the cache
//
// Keyed by lower-cased address so a wallet switch cannot serve the previous
// wallet's credential. In-flight promises are shared per address: three
// components mounting at once (pool page, claim client, dashboard) must
// produce ONE prompt, not three.

const credentials = new Map<string, WalletAuthCredential>();
const inflight = new Map<string, Promise<ClientAuth>>();

/** Test seam and wallet-switch cleanup. Omit the address to drop everything. */
export function clearWalletAuth(address?: string): void {
  if (address === undefined) {
    credentials.clear();
    inflight.clear();
    return;
  }
  const key = address.toLowerCase();
  credentials.delete(key);
  inflight.delete(key);
}

/** The cached credential for an address, or null when absent or stale. */
export function cachedWalletAuth(
  address: string,
  nowMs: number = Date.now(),
): WalletAuthCredential | null {
  const credential = credentials.get(address.toLowerCase());
  if (credential === undefined) return null;
  if (!credentialUsableAt(credential, address, nowMs)) {
    credentials.delete(address.toLowerCase());
    return null;
  }
  return credential;
}

function ok(credential: WalletAuthCredential): ClientAuth {
  return { kind: "ok", credential, headers: authHeadersOf(credential) };
}

/**
 * Produce (or reuse) a signature proving control of `address`.
 *
 * Never throws: a declined prompt and a broken signer are states the UI has to
 * render, not exceptions to escape into a render. `refresh` forces a new
 * signature, which is what a 401 on a cached credential calls for.
 */
export async function getWalletAuth(params: {
  address: string | null;
  signMessage: SignMessageFn | null;
  refresh?: boolean;
  /** Use a cached credential if there is one, but never open a wallet prompt.
   *  For surfaces the user did not ask to unlock. */
  cachedOnly?: boolean;
  now?: () => number;
}): Promise<ClientAuth> {
  const { address, signMessage } = params;
  const now = params.now ?? Date.now;
  if (address === null || signMessage === null) return { kind: "no-wallet" };

  const key = address.toLowerCase();
  if (params.refresh === true) clearWalletAuth(address);

  const cached = cachedWalletAuth(address, now());
  if (cached !== null) return ok(cached);

  const pending = inflight.get(key);
  if (pending !== undefined) return pending;

  // A prompt already in flight is shared above; only a genuinely absent
  // credential stops here, so a cached-only reader still benefits from a
  // signature another surface is in the middle of collecting.
  if (params.cachedOnly === true) return { kind: "unsigned" };

  const attempt = (async (): Promise<ClientAuth> => {
    const timestamp = new Date(now()).toISOString();
    try {
      const signature = await signMessage(
        clientWalletAuthMessage(address, timestamp),
      );
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
        return {
          kind: "failed",
          message: "the wallet returned a signature this app cannot use",
        };
      }
      const credential: WalletAuthCredential = {
        address,
        timestamp,
        signature,
      };
      credentials.set(key, credential);
      return ok(credential);
    } catch (err) {
      if (isUserRejection(err)) return { kind: "declined" };
      return {
        kind: "failed",
        message:
          err instanceof Error && err.message !== ""
            ? err.message
            : "the wallet could not sign",
      };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, attempt);
  return attempt;
}

// -------------------------------------------------------------- signed fetch

export type WalletAuthRequester = (options?: {
  refresh?: boolean;
  cachedOnly?: boolean;
}) => Promise<ClientAuth>;

export interface WalletAuthFetchResult {
  response: Response;
  /** The auth state the final request was made under. "ok" means the headers
   *  were attached; anything else means the server saw an unsigned request and
   *  the caller must render the reduced answer honestly. */
  auth: ClientAuth;
}

/**
 * Fetch with the wallet headers attached when a signature is available.
 *
 * Deliberately still sends the request when there is no signature: the routes
 * answer an unsigned caller with a redacted projection, and that answer is
 * what lets the UI say "a claim exists, sign to see it" instead of showing a
 * blank box. A 401 against a credential that WAS attached means the cached
 * signature aged past the server's window, so it is dropped and re-signed once
 * - a stale cache must never look like a permission failure.
 */
export async function fetchWithWalletAuth(
  url: string,
  init: RequestInit | undefined,
  requestAuth: WalletAuthRequester,
  fetchImpl: typeof fetch = fetch,
): Promise<WalletAuthFetchResult> {
  const auth = await requestAuth();
  const send = (current: ClientAuth) => {
    const headers = new Headers(init?.headers);
    if (current.kind === "ok") {
      for (const [name, value] of Object.entries(current.headers)) {
        headers.set(name, value);
      }
    }
    return fetchImpl(url, { ...init, headers });
  };

  const response = await send(auth);
  if (response.status !== 401 || auth.kind !== "ok") {
    return { response, auth };
  }

  const retryAuth = await requestAuth({ refresh: true });
  if (retryAuth.kind !== "ok") return { response, auth: retryAuth };
  return { response: await send(retryAuth), auth: retryAuth };
}

// ------------------------------------------------- third-party fetch wrapping
//
// The Unlink browser SDK takes ONE customFetch and uses it for both our
// /api/unlink/* capability routes and the Unlink Engine's own host. The
// credential proves control of a wallet, so it goes to our origin and nowhere
// else - handing it to a third party would be handing over a bearer token.

/** True only for a request back to this app: a relative path, or an absolute
 *  URL whose origin matches. Anything unparseable is treated as foreign. */
export function shouldAttachWalletAuth(url: string, origin: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("//")) return true;
  try {
    return new URL(url, origin).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** The URL a fetch argument addresses, for the same-origin decision. */
export function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * A fetch that attaches the wallet headers to same-origin requests only.
 * Handed to createUnlinkClient({ customFetch }) so the SDK's own calls to the
 * capability routes carry the proof, while Engine traffic stays clean.
 *
 * The credential is resolved per request, not captured once: the Unlink client
 * outlives a ten minute window and rotates its capability token on its own
 * schedule, so a frozen credential would work at derive time and 401 an hour
 * later. `requestAuth` is cached, so this costs nothing until it expires.
 */
export function walletAuthFetch(
  requestAuth: WalletAuthRequester,
  origin: string,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!shouldAttachWalletAuth(fetchInputUrl(input), origin)) {
      return fetchImpl(input, init);
    }
    const auth = await requestAuth();
    // An unsigned request is sent as-is and the route answers 401: the SDK
    // surfaces that as a failure, which is the loud direction for a money
    // path. Silently dropping the call would look like a hung UI.
    const headers = auth.kind === "ok" ? auth.headers : {};
    if (typeof input === "string" || input instanceof URL) {
      const merged = new Headers(init?.headers);
      for (const [name, value] of Object.entries(headers)) {
        merged.set(name, value);
      }
      return fetchImpl(input, { ...init, headers: merged });
    }
    // A Request carries its own headers; merge rather than replace, or the
    // SDK's content-type and accept headers are lost with the body.
    const merged = new Headers(input.headers);
    for (const [name, value] of Object.entries(headers)) {
      merged.set(name, value);
    }
    return fetchImpl(new Request(input, { headers: merged }), init);
  };
}
