"use client";

// WearableProve - the self-contained wearable proof surface the Claim Rail
// slots in.
//
// The Claim Rail owns the overall pool page and decides WHERE a claim surface
// sits; this component owns everything that happens INSIDE the wearable path,
// so the rail only has to render <WearableProve poolId goalSpec /> and place
// it. Nothing else has to be wired: the component gates on the wallet, reads
// the Junction provider state, drives the connect flow, hands the claim to
// SPOTTER through /api/agent/run/[goalId] (evidenceKind "wearable", no
// attesterId), restores an in-flight claim on mount, and prints the receipt -
// the full flow, decoupled from any one page's structure.
//
// It is a thin, stable seam over the WearableCheck implementation rather than a
// second copy of that ~850-line run loop: one implementation, one set of
// privacy-honest copy, one place a bug gets fixed. The rail imports this name
// so it never has to reach for an internal component, and the seam can later
// absorb rail-specific affordances (an onProven callback, a compact variant)
// without the rail changing its import.
//
// Privacy boundary: the wearable path reads the synced summary on SPOTTER's
// own server (lib/server/junction.ts + lib/server/agent/wearable.ts) and
// derives the verdict there. Raw health data never leaves that server boundary
// and only the pass/fail verdict and its confidence are written on-chain. This
// is NOT the confidential enclave the document path runs in, and the copy on
// this surface says so - it must never claim a sealed enclave for wearables.

import WearableCheck from "@/components/WearableCheck";

export interface WearableProveProps {
  /** The pool this claim is for. */
  poolId: bigint;
  /** The pool's on-chain goal text; the streak parameters are parsed from it
   *  server-side and the display label is derived from it here. */
  goalSpec: string;
  /** Optional hand-off to the document proof path. When the rail offers a
   *  document tab it passes this so a dead provider or an unreadable wearable
   *  read can move the user there in one tap; omit it and the wearable path
   *  simply never offers the switch. */
  onSwitchToDocument?: () => void;
}

export default function WearableProve({
  poolId,
  goalSpec,
  onSwitchToDocument,
}: WearableProveProps) {
  return (
    <WearableCheck
      poolId={poolId}
      goalSpec={goalSpec}
      onSwitchToDocument={onSwitchToDocument}
    />
  );
}
