"use client";

// A one-shot confetti burst for the payout moment: coral + gold + emerald
// pieces rain from the coin, then they are gone (never looping). Generated on
// the client only (mounted gate) so server and client markup agree, and it
// renders nothing at all under prefers-reduced-motion.

import { useEffect, useMemo, useState } from "react";

// Gold is reserved strictly for money in motion, so the celebration burst is
// never gold: coral = people, emerald = water. The gold lives only on the coin
// and the amount, which is what actually moved.
const COLORS = [
  "var(--coral)",
  "var(--coral-strong)",
  "var(--accent)",
  "var(--accent-strong)",
];

export default function Confetti({ count = 20 }: { count?: number }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const pieces = useMemo(() => {
    if (!mounted) return [];
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return [];
    }
    return Array.from({ length: count }, (_, i) => ({
      key: i,
      dx: (Math.random() - 0.5) * 340,
      dy: 130 + Math.random() * 190,
      rot: (Math.random() - 0.5) * 720,
      delay: Math.random() * 140,
      size: 6 + Math.random() * 6,
      color: COLORS[i % COLORS.length],
    }));
  }, [mounted, count]);

  if (pieces.length === 0) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {pieces.map((p) => (
        <span
          key={p.key}
          className="confetti-piece"
          style={{
            left: "50%",
            top: "40%",
            width: `${p.size}px`,
            height: `${p.size * 1.6}px`,
            backgroundColor: p.color,
            animationDelay: `${p.delay}ms`,
            ["--dx" as string]: `${p.dx}px`,
            ["--dy" as string]: `${p.dy}px`,
            ["--rot" as string]: `${p.rot}deg`,
          }}
        />
      ))}
    </div>
  );
}
