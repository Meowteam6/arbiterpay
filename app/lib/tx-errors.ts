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

// ------------------------------------------------------------ funding preflight

/**
 * Gas headroom for a two-transaction flow (approve + write) on Arc testnet,
 * in 6-decimal USDC base units (0.05 USDC). Arc pays gas in native USDC and
 * the canonical ERC-20 balance mirrors it, so the wallet's USDC balance must
 * cover whatever the contract pulls plus this margin before any transaction
 * is attempted.
 */
export const JOIN_GAS_MARGIN = 50_000n;

/**
 * Decide whether a wallet's USDC balance can cover a contract call that pulls
 * `pulled` USDC: the pulled amount plus a gas margin, all in 6-decimal base
 * units. Joining (entry fee) and depositing (funding, top-up, stake) are the
 * same approve-then-write shape, so one margin serves both.
 */
export function canCoverUsdcCosts(
  balance: bigint,
  pulled: bigint,
  gasMargin: bigint = JOIN_GAS_MARGIN,
): boolean {
  return balance >= pulled + gasMargin;
}

/** Join-flow alias, kept so the JoinPool call site reads in its own terms. */
export const canCoverJoinCosts = canCoverUsdcCosts;

/** The Circle testnet faucet. One canonical URL for every funding surface. */
export const FAUCET_URL = "https://faucet.circle.com";

/**
 * The funding steps, in the order a first-time user performs them. The faucet
 * takes a pasted address and a chosen network - it does not "send" anywhere -
 * and Arc Testnet sits in a long network dropdown, so both are called out.
 * FundingHelp renders these with a copy button and a real link; the deposit
 * hook folds the same sequence into one line (FUNDING_HELP_DETAIL) because it
 * can only hand consumers a string.
 */
export const FUNDING_STEPS: readonly string[] = [
  "Copy your wallet address.",
  "Open faucet.circle.com.",
  "Choose Arc Testnet in the network dropdown.",
  "Paste your address and request the test USDC.",
  "Come back here and check again.",
];

/**
 * One-line funding instruction for surfaces that can only render a string
 * (anything reading DepositStatus.message through an ErrorNote).
 */
export const FUNDING_HELP_DETAIL =
  "Arc testnet pays gas in USDC, so a zero balance blocks every transaction. " +
  "Copy your wallet address from the header, open faucet.circle.com, choose " +
  "Arc Testnet, paste the address, request test USDC, then try again.";

/**
 * The funding message with the numbers in it. Balances arrive as pre-formatted
 * display strings so this module stays free of formatting concerns and stays
 * trivially testable.
 */
export function fundingShortfallDetail(
  balanceLabel: string,
  neededLabel: string,
): string {
  return (
    `This wallet holds ${balanceLabel} USDC and needs about ${neededLabel} ` +
    `USDC for this action. ${FUNDING_HELP_DETAIL}`
  );
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
    // Wrong-network failures. The phrases are matched, not the bare words
    // "chain" and "network": viem prints "chain: Arc Testnet (id: 5042002)"
    // inside the request-arguments dump of EVERY failed write, so a bare
    // /chain|network/ rule would relabel unrelated failures as wrong network.
    // 4902 is the EIP-1193 "unrecognized chain" code wallets return when the
    // network was never added.
    pattern:
      /does not match the target chain|chain mismatch|chain of the wallet|unrecognized chain|unrecognized network|chain not configured|unsupported chain|wrong network|switch (?:to )?(?:the )?(?:network|chain)|network mismatch|\b4902\b/i,
    title: "Wallet is on the wrong network",
    detail:
      "This wallet is not on Arc testnet. Switch the wallet to Arc Testnet " +
      "(chain id 5042002) and try again - GoHealthMe only settles there.",
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
  {
    // Last rule on purpose. A revert with a known reason is caught by the
    // rules above; this catches the rest, including a transaction that mined
    // and then reverted (viem resolves the receipt either way, so the callers
    // check receipt.status and throw). Saying "try again" would be wrong -
    // nothing moved and the same call will usually revert again.
    pattern: /\breverted\b/i,
    title: "Transaction reverted",
    detail:
      "The transaction was mined on Arc testnet and then reverted, so nothing " +
      "moved. No USDC changed hands beyond the gas the wallet already spent.",
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
