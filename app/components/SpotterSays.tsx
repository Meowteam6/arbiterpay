"use client";

// A small transparent SPOTTER + an anchored speech bubble, for empty/loading
// slots so no screen is ever just the run-across easter egg.
//
// Hydration: the pick is random (per-session), so it is drawn ONLY on the
// client in an effect — never in a useState initializer, which would draw a
// different line on the server and mismatch. First paint renders nothing; the
// line pops in a beat later. Renders nothing if the slot has no line.

import { useEffect, useState } from "react";
import { spotterSays, type SpotterPick } from "@/lib/spotter-says";
import type { Locale, Surface, SpotterState, Tone } from "@/lib/spotter-lines";

// State -> a TRANSPARENT pose (spotter-*.png cutouts only; never the cream-bg
// card poses, which would show a square).
const POSE_BY_STATE: Record<SpotterState, string> = {
  idle: "lounging",
  empty: "peek",
  verifying: "peek",
  "won-verified": "payday",
  "paid-self-reported": "standing",
  broke: "broke",
  error: "standing",
  "streak-nudge": "standing",
};

// Tone -> a subtle bubble accent. GOLD is never used here: gold is money in
// motion, which lives in the mono amount slot, not SPOTTER's mouth.
const TONE_BORDER: Record<Tone, string> = {
  loud: "border-accent/40",
  warn: "border-warning/40",
  dry: "border-edge",
  deadpan: "border-edge",
};

const SIZE: Record<string, string> = { sm: "w-16", md: "w-24" };

export default function SpotterSays({
  surface,
  state,
  pose,
  size = "sm",
  align = "left",
  locale,
}: {
  surface: Surface;
  state: SpotterState;
  pose?: string;
  size?: "sm" | "md";
  align?: "left" | "right";
  locale?: Locale;
}) {
  const [pick, setPick] = useState<SpotterPick | null>(null);
  useEffect(() => {
    setPick(spotterSays(surface, state, { locale }));
  }, [surface, state, locale]);

  if (pick === null) return null;
  const resolvedPose = pose ?? POSE_BY_STATE[state];

  return (
    <div
      className={`flex items-end gap-2 ${align === "right" ? "flex-row-reverse" : ""}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/spotter/spotter-${resolvedPose}.png`}
        alt=""
        aria-hidden="true"
        className={`${SIZE[size]} h-auto shrink-0 self-end`}
      />
      <div
        className={`max-w-[15rem] rounded-2xl ${align === "left" ? "rounded-bl-sm" : "rounded-br-sm"} border ${TONE_BORDER[pick.tone]} bg-surface px-3 py-2 text-xs font-medium leading-snug text-foreground shadow-sm`}
      >
        {pick.text}
      </div>
    </div>
  );
}
