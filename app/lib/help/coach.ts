// The onboarding coach's state machine. Pure and client-safe: no hooks, no
// network, no LLM. It reads the three signals the widget already has - auth,
// on-chain USDC balance, whether a handle is claimed - plus the current path,
// and returns the SINGLE next step to surface. The widget wires the returned
// action id to a real handler (login, fund, route, scroll); this module only
// decides which step is current, so the decision is unit-testable in isolation.
//
// Reliability over cleverness: first match wins, there is exactly one current
// step, and the balance-loading case is explicit so the UI never flashes the
// wrong step while the balance query is still resolving.

/** The actionable steps, in order. `paid` is the terminal goal, never current. */
export type CoachAction =
  | "signIn"
  | "getUsdc"
  | "claimHandle"
  | "doTheThing"
  | "uploadProof";

export interface CoachInputs {
  authenticated: boolean;
  /** On-chain Arc USDC in base units, or undefined while the query loads. */
  balance: bigint | undefined;
  handleClaimed: boolean;
  pathname: string;
}

export interface CoachStep {
  id: CoachAction;
  /** Position in COACH_CHECKLIST (0..4). */
  index: number;
  /** Balance is still resolving: hold this step, do not auto-advance or fire. */
  loading: boolean;
}

/**
 * A pool DETAIL page (/pools/<id>), not the list and not /pools/create. This is
 * where proof gets uploaded, so it is the one place the coach overrides its
 * linear flow with a contextual nudge.
 */
export function isPoolDetailPath(pathname: string): boolean {
  const match = /^\/pools\/([^/]+)\/?$/.exec(pathname);
  return match !== null && match[1] !== "create";
}

/**
 * The current step. First match wins.
 *
 *   override  on a funded pool-detail page   -> uploadProof
 *   1         not signed in                  -> signIn
 *   (hold)    signed in, balance unknown      -> getUsdc, loading
 *   2         signed in, balance 0            -> getUsdc
 *   3         funded, no handle               -> claimHandle
 *   4         funded, handle claimed          -> doTheThing
 */
export function resolveCoachStep(input: CoachInputs): CoachStep {
  const { authenticated, balance, handleClaimed, pathname } = input;

  if (!authenticated) {
    return { id: "signIn", index: 0, loading: false };
  }

  const balanceKnown = balance !== undefined;
  const funded = balanceKnown && balance > 0n;

  // Contextual override: a funded user reading a specific pool is here to claim,
  // so point at the proof upload rather than the linear next step. Gated on
  // funded so an unfunded visitor is never told to upload before they can join.
  if (funded && isPoolDetailPath(pathname)) {
    return { id: "uploadProof", index: 4, loading: false };
  }

  if (!balanceKnown) {
    // Signed in but the balance query has not answered yet. Hold on the funding
    // step and let the widget show a pulse instead of firing a premature fund.
    return { id: "getUsdc", index: 1, loading: true };
  }

  if (!funded) {
    return { id: "getUsdc", index: 1, loading: false };
  }

  if (!handleClaimed) {
    return { id: "claimHandle", index: 2, loading: false };
  }

  return { id: "doTheThing", index: 3, loading: false };
}

export interface ChecklistRow {
  id: CoachAction | "paid";
  label: string;
  /** The payout row wears gold - the only gold in the widget. */
  gold?: boolean;
}

/** Always six rows, always the same order. */
export const COACH_CHECKLIST: ChecklistRow[] = [
  { id: "signIn", label: "Sign in" },
  { id: "getUsdc", label: "Get test USDC" },
  { id: "claimHandle", label: "Claim your handle" },
  { id: "doTheThing", label: "Create or join" },
  { id: "uploadProof", label: "Upload your proof" },
  { id: "paid", label: "Get paid", gold: true },
];

export interface CoachCopy {
  headline: string;
  body: string;
  primary: string;
  /** Only doTheThing offers a real either/or. */
  secondary?: string;
}

/** Scripted copy per step. GoHealthMe voice: direct, no emoji, no exclamations. */
export function coachCopy(id: CoachAction): CoachCopy {
  switch (id) {
    case "signIn":
      return {
        headline: "Start here",
        body: "Sign in with an email address. We create the wallet for you - no seed phrase, no extension, nothing to install.",
        primary: "Sign in",
      };
    case "getUsdc":
      return {
        headline: "Grab some test USDC",
        body: "Arc pays gas in USDC, so your wallet needs a little to move. One tap gets you test funds. Play-money, no real value.",
        primary: "Get test USDC",
      };
    case "claimHandle":
      return {
        headline: "Claim your handle",
        body: "Pick a public handle so friends can find you. Your health data stays private either way.",
        primary: "Claim your handle",
      };
    case "doTheThing":
      return {
        headline: "Now the fun part",
        body: "Start a challenge and dare a friend, or join a sponsor pool and go earn.",
        primary: "Create a challenge",
        secondary: "Browse pools",
      };
    case "uploadProof":
      return {
        headline: "Upload your proof",
        body: "Drop your proof on this pool. SPOTTER verifies it inside the enclave and pays you the moment it checks out.",
        primary: "Upload your proof",
      };
  }
}
