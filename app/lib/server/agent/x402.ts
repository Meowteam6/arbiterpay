// SPOTTER's buy side: per-claim service purchases over x402 via Circle
// Gateway, with an honest prepaid fallback.
//
// Three services quote here. The cheap read ("attester-read") covers the TEE
// attester inference this claim consumed; the escalation ("vision-judge") is
// the second opinion SPOTTER buys only when the cheap read comes back
// unreadable; the settlement check ("chain-read") is one paid JSON-RPC call
// through QuickNode's x402 gateway that independently verifies a settle
// transaction. Service endpoints are env-driven: with X402_PRIVATE_KEY and a
// service URL set, the purchase is a real Gateway-batched x402 payment from
// the agent's spend key and the ledger row carries the Gateway transaction.
// With them unset, the service is metered under an existing API key and the
// row says settlement "prepaid" - never a fake payment reference.
//
// The spend key is deliberately NOT the Circle wallet: GatewayClient needs a
// raw private key, so a second EOA holds the small verification budget while
// the Circle wallet stays the settler/oracle identity.
//
// Privacy: request bodies here carry derived data only (attester job id, the
// public goalSpec, the derived verdict). Document bytes never reach a
// marketplace service; the TEE attester is the only thing that ever sees them.

import { GatewayClient } from "@circle-fin/x402-batching/client";
import type { Hex } from "viem";
import { optionalEnv } from "@/lib/server/env";

export const ATTESTER_READ_SERVICE = "attester-read";
export const ATTESTER_READ_LABEL = "document read (TEE attester)";
export const ATTESTER_READ_EST_USD = "0.02";

export const VISION_JUDGE_SERVICE = "vision-judge";
export const VISION_JUDGE_LABEL = "vision judge (Gemini)";
export const VISION_JUDGE_EST_USD = "0.35";

export const CHAIN_READ_SERVICE = "chain-read";
export const CHAIN_READ_LABEL = "chain verification read (QuickNode, x402)";
export const CHAIN_READ_EST_USD = "0.01";
// QuickNode's live x402 offer for Arc testnet (eip155:5042002,
// GatewayWalletBatched v1, $0.0001/request) - GatewayClient pays it as-is.
// Only used when a spend key exists; otherwise the quote is prepaid/null and
// the free-RPC verification path runs instead.
const CHAIN_READ_DEFAULT_URL = "https://x402.quicknode.com/arc-testnet/";

export interface ServiceQuote {
  service: string;
  label: string;
  /** Two-decimal USD estimate the plan and the cap check use. */
  estUsd: string;
  /** Paid endpoint, or null when the service settles prepaid. */
  url: string | null;
}

export interface PurchaseResult {
  /** What was actually spent, two decimals, rounded up to the cent. */
  amountUsd: string;
  settlement: "x402" | "prepaid";
  /** Gateway settlement transaction for x402 purchases; null for prepaid. */
  gatewayTx: string | null;
  /** Service response body for x402 purchases; null for prepaid. */
  data: unknown;
}

export interface BuyOptions {
  /**
   * Stable per-(claim, service, ref) key sent as an Idempotency-Key header.
   *
   * gw.pay() has no idempotency parameter of its own, so a retry that reaches
   * the endpoint twice is charged twice unless the endpoint dedupes. The
   * authority against double spending is the caller's own intent marker plus
   * the ledger; this header is the cheap half of the belt-and-braces, honoured
   * by providers that support it and ignored harmlessly by those that do not.
   */
  idempotencyKey?: string;
}

export interface BuyDeps {
  quoteAttesterRead(): Promise<ServiceQuote>;
  quoteVisionJudge(): Promise<ServiceQuote>;
  quoteChainRead(): Promise<ServiceQuote>;
  buy(
    quote: ServiceQuote,
    body: Record<string, unknown>,
    options?: BuyOptions,
  ): Promise<PurchaseResult>;
}

/** Whole-cent arithmetic for cap headroom checks. Throws on malformed input
 *  so a bad amount can never slip past the cap as zero. */
export function usdCents(amount: string): number {
  if (!/^\d+\.\d{2}$/.test(amount)) {
    throw new Error(
      `amount ${JSON.stringify(amount)} must be a USD string with exactly two decimals`,
    );
  }
  const [dollars, cents] = amount.split(".");
  return Number(dollars) * 100 + Number(cents);
}

/** USDC atomic units (6 decimals) to a two-decimal USD string, rounded UP -
 *  the ledger must never understate what left the wallet. */
function atomicToUsdCeil(atomic: bigint): string {
  const cents = (atomic + 9_999n) / 10_000n;
  const dollars = cents / 100n;
  const rem = cents % 100n;
  return `${dollars.toString()}.${rem.toString().padStart(2, "0")}`;
}

let cachedGateway: GatewayClient | null = null;

function gateway(): GatewayClient | null {
  const key = optionalEnv("X402_PRIVATE_KEY", "");
  if (key === "") return null;
  if (cachedGateway === null) {
    cachedGateway = new GatewayClient({
      chain: "arcTestnet",
      privateKey: (key.startsWith("0x") ? key : `0x${key}`) as Hex,
    });
  }
  return cachedGateway;
}

/**
 * Price a service before committing to it. When the endpoint answers the
 * supports() preflight with Gateway batching requirements, the quoted amount
 * replaces the static estimate, so the plan row shows the price SPOTTER will
 * actually pay. Any preflight failure quietly downgrades to prepaid - the
 * claim must not die because a marketplace endpoint was unreachable.
 */
async function quoteService(
  service: string,
  label: string,
  fallbackEstUsd: string,
  urlEnv: string,
  defaultUrl = "",
): Promise<ServiceQuote> {
  const url = optionalEnv(urlEnv, defaultUrl);
  const gw = gateway();
  if (url === "" || gw === null) {
    return { service, label, estUsd: fallbackEstUsd, url: null };
  }
  try {
    const preflight = await gw.supports(url);
    if (!preflight.supported) {
      return { service, label, estUsd: fallbackEstUsd, url: null };
    }
    const raw = preflight.requirements?.amount;
    let estUsd = fallbackEstUsd;
    if (typeof raw === "string" && raw !== "") {
      // x402 requirements carry the amount in USDC atomic units; a decimal
      // point means the endpoint already speaks USD.
      estUsd = raw.includes(".")
        ? atomicToUsdCeil(BigInt(Math.ceil(Number(raw) * 1_000_000)))
        : atomicToUsdCeil(BigInt(raw));
    }
    return { service, label, estUsd, url };
  } catch {
    return { service, label, estUsd: fallbackEstUsd, url: null };
  }
}

async function buyLive(
  quote: ServiceQuote,
  body: Record<string, unknown>,
  options?: BuyOptions,
): Promise<PurchaseResult> {
  if (quote.url === null) {
    return {
      amountUsd: quote.estUsd,
      settlement: "prepaid",
      gatewayTx: null,
      data: null,
    };
  }
  const gw = gateway();
  if (gw === null) {
    // The quote was priced with a key that has since disappeared from env.
    // Fall back rather than fail the claim; the ledger row will say prepaid.
    return {
      amountUsd: quote.estUsd,
      settlement: "prepaid",
      gatewayTx: null,
      data: null,
    };
  }
  const paid = await gw.pay(quote.url, {
    method: "POST",
    body,
    headers:
      options?.idempotencyKey === undefined
        ? undefined
        : { "Idempotency-Key": options.idempotencyKey },
  });
  return {
    amountUsd: atomicToUsdCeil(paid.amount),
    settlement: "x402",
    gatewayTx: paid.transaction,
    data: paid.data,
  };
}

export function liveBuyDeps(): BuyDeps {
  return {
    quoteAttesterRead: () =>
      quoteService(
        ATTESTER_READ_SERVICE,
        ATTESTER_READ_LABEL,
        ATTESTER_READ_EST_USD,
        "X402_ATTESTER_READ_URL",
      ),
    quoteVisionJudge: () =>
      quoteService(
        VISION_JUDGE_SERVICE,
        VISION_JUDGE_LABEL,
        VISION_JUDGE_EST_USD,
        "X402_VISION_JUDGE_URL",
      ),
    // Defaults to QuickNode's public Arc-testnet x402 endpoint the moment a
    // spend key exists; without one, quoteService degrades this to prepaid
    // and the caller must not write any chain-read spend row.
    quoteChainRead: () =>
      quoteService(
        CHAIN_READ_SERVICE,
        CHAIN_READ_LABEL,
        CHAIN_READ_EST_USD,
        "X402_CHAIN_READ_URL",
        CHAIN_READ_DEFAULT_URL,
      ),
    buy: buyLive,
  };
}
