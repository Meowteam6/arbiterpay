/**
 * Human-readable translations for wallet and contract transaction errors.
 *
 * viem throws multi-line, stack-style messages ("The total cost (gas * gas
 * fee + value) ... Version: viem@2.x") that must never reach an ErrorNote
 * verbatim. This module maps known HealthPools revert reasons and common
 * wallet failures to one-line human messages. The untouched raw text is
 * preserved in `raw` so the UI can offer it behind a collapsed
 * technical-details element.
 */

export interface HumanTxError {
  title: string;
  detail: string;
  raw: string;
}

// ------------------------------------------------------------- join preflight

/**
 * Gas headroom for a join (approve + joinPool) on Arc testnet, in 6-decimal
 * USDC base units (0.05 USDC). Arc pays gas in native USDC and the canonical
 * ERC-20 balance mirrors it, so the wallet's USDC balance must cover the
 * entry fee plus this margin before any transaction is attempted.
 */
export const JOIN_GAS_MARGIN = 50_000n;

/**
 * Decide whether a wallet's USDC balance can cover joining a pool: the entry
 * fee the contract pulls plus a small gas margin, all in 6-decimal base units.
 */
export function canCoverJoinCosts(
  balance: bigint,
  entryFee: bigint,
  gasMargin: bigint = JOIN_GAS_MARGIN,
): boolean {
  return balance >= entryFee + gasMargin;
}

// ------------------------------------------------------------- error mapping

const INSUFFICIENT_FUNDS_DETAIL =
  "This wallet does not have enough USDC to cover the transaction. " +
  "Arc testnet pays gas in USDC - get test USDC at faucet.circle.com " +
  "or top up from the dashboard balance card.";

const GENERIC_DETAIL =
  "Something went wrong while sending the transaction. Try again in a moment.";

interface ErrorRule {
  pattern: RegExp;
  title: string;
  detail: string;
}

/**
 * Ordered rules. Contract revert reasons are matched case-sensitively on
 * word boundaries (underscore counts as a word character, so SETTLED does
 * not match inside ALREADY_SETTLED); wallet phrases match case-insensitively.
 */
const RULES: readonly ErrorRule[] = [
  {
    pattern: /\bPERIOD_ENDED\b/,
    title: "Joining is closed",
    detail: "This pool's period has ended - joining is closed.",
  },
  {
    pattern: /\bALREADY_JOINED\b/,
    title: "Already in",
    detail: "This wallet already joined this pool.",
  },
  {
    pattern: /\bNULLIFIER_USED\b/,
    title: "Entry already used",
    detail:
      "This entry was already used to join this pool - one wallet, one entry.",
  },
  {
    pattern: /\bPOOL_FULL\b/,
    title: "Pool is full",
    detail: "This pool has reached its participant limit.",
  },
  {
    pattern: /\b(?:ALREADY_)?SETTLED\b/,
    title: "Pool already settled",
    detail: "This pool has already settled - no further transactions are accepted.",
  },
  {
    pattern: /\bNOT_PARTICIPANT\b/,
    title: "Not a participant",
    detail: "This wallet has not joined this pool.",
  },
  {
    pattern: /\bZERO_AMOUNT\b/,
    title: "Amount is zero",
    detail: "The amount must be greater than zero.",
  },
  {
    pattern: /\bNo EVM wallet connected\b/i,
    title: "Wallet not connected",
    detail: "No wallet is connected - sign in and try again.",
  },
  {
    pattern: /user rejected|user denied|rejected the request/i,
    title: "Transaction cancelled",
    detail: "You cancelled the transaction.",
  },
  {
    pattern:
      /insufficient funds|exceeds the balance of the account|transfer amount exceeds balance/i,
    title: "Not enough USDC",
    detail: INSUFFICIENT_FUNDS_DETAIL,
  },
];

/** Top-level message text, untouched, for the technical-details view. */
function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    const json = JSON.stringify(err);
    return json === undefined ? String(err) : json;
  } catch {
    return String(err);
  }
}

/**
 * Collect message text down the cause chain. viem nests the useful part
 * (revert reason, node message) inside `cause`, so matching only the top
 * message would miss it.
 */
function messageChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current !== null && current !== undefined && depth < 10) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    const { message, shortMessage, cause } = current as {
      message?: unknown;
      shortMessage?: unknown;
      cause?: unknown;
    };
    if (typeof message === "string") parts.push(message);
    if (typeof shortMessage === "string") parts.push(shortMessage);
    current = cause;
    depth += 1;
  }
  return parts.join("\n");
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "");
  return line === undefined ? GENERIC_DETAIL : line.trim();
}

/**
 * Map an unknown thrown value from a wallet or contract call to a one-line
 * human title and detail. The raw text is preserved verbatim in `raw` and
 * must only ever render collapsed, never as the primary message.
 */
export function humanizeTxError(err: unknown): HumanTxError {
  const raw = rawMessage(err);
  const chain = messageChain(err);

  // Configuration errors already carry a human first line - keep it.
  if (/is not configured/i.test(chain)) {
    return { title: "App is not configured", detail: firstLine(chain), raw };
  }

  for (const rule of RULES) {
    if (rule.pattern.test(chain)) {
      return { title: rule.title, detail: rule.detail, raw };
    }
  }
  return { title: "Transaction failed", detail: GENERIC_DETAIL, raw };
}
