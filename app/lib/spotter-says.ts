// The picker: pure, SSR-safe, deterministic under an injected rng, and it never
// repeats a line back-to-back in the same slot (persisted per session). Returns
// null when a slot has no line so the caller renders nothing rather than a gap.

import { SPOTTER_LINES } from "./spotter-lines";
import type { Locale, Surface, SpotterState, Tone } from "./spotter-lines";

export interface SpotterPick {
  id: string;
  text: string;
  tone: Tone;
}

export function spotterSays(
  surface: Surface,
  state: SpotterState,
  opts: { locale?: Locale; rng?: () => number; storage?: Storage | null } = {},
): SpotterPick | null {
  const locale = opts.locale ?? "en";
  const rng = opts.rng ?? Math.random;
  const storage =
    opts.storage !== undefined
      ? opts.storage
      : typeof window !== "undefined"
        ? window.sessionStorage
        : null;

  let candidates = SPOTTER_LINES.filter(
    (l) => l.surface === surface && l.state === state,
  );
  if (candidates.length === 0) return null;

  const key = `ghm.spotter.${surface}.${state}`;
  let lastId: string | null = null;
  try {
    lastId = storage?.getItem(key) ?? null;
  } catch {
    lastId = null;
  }

  if (candidates.length > 1 && lastId !== null) {
    const pruned = candidates.filter((l) => l.id !== lastId);
    if (pruned.length > 0) candidates = pruned;
  }

  const total = candidates.reduce((sum, l) => sum + (l.weight ?? 1), 0);
  let roll = rng() * total;
  let chosen = candidates[candidates.length - 1];
  for (const line of candidates) {
    roll -= line.weight ?? 1;
    if (roll <= 0) {
      chosen = line;
      break;
    }
  }

  try {
    storage?.setItem(key, chosen.id);
  } catch {
    /* private-mode Safari throws on setItem; the line still shows. */
  }

  return {
    id: chosen.id,
    text: chosen.text[locale] ?? chosen.text.en,
    tone: chosen.tone,
  };
}
