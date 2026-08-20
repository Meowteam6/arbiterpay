"use client";

// The first-run helper. One floating bubble, bottom-right, app-wide. Three
// tabs: Coach (scripted, state-aware, no LLM), Ask (guarded Gemini), Feedback
// (Supabase). Dismissible, mobile-first, never a trapping modal.
//
// It reuses the app's existing reads rather than rebuilding them:
//   - auth + address + login  from useEmbeddedWallet (safe in both provider
//     branches: the stub answers signed-out when Dynamic is unconfigured)
//   - on-chain USDC balance    from the SAME react-query key + fn as
//     TestUsdcChip, so the cache is shared and nothing double-fetches
//   - handle-claimed           from the existing /api/social/resolve lookup
//   - one-tap funding          from useTestUsdcFunding, the chip's own chain
//
// The coach's decision lives in lib/help/coach.ts (pure, tested); this file
// only wires the returned step to a real handler and paints it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { useEmbeddedWallet } from "@/lib/wallet";
import { fetchWalletUsdc, useTestUsdcFunding } from "@/lib/faucet-funding";
import {
  COACH_CHECKLIST,
  coachCopy,
  resolveCoachStep,
  type CoachStep,
} from "@/lib/help/coach";
import {
  ASK_PER_SESSION_CAP,
  MAX_QUESTION_CHARS,
} from "@/lib/server/help/knowledge";

type Tab = "coach" | "ask" | "feedback";
type AskMessage = { role: "you" | "spotter"; text: string };
type Rating = "easy" | "confusing";

const STORE_KEY = "ghm-helper";
const SESSION_KEY = "ghm-helper-session";

interface Persisted {
  autoOpened?: boolean;
  dismissed?: boolean;
}

function readPersisted(): Persisted {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    return raw !== null ? (JSON.parse(raw) as Persisted) : {};
  } catch {
    return {};
  }
}

function writePersisted(next: Persisted): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // A private-mode storage failure must not break the widget.
  }
}

/** A stable per-browser id for anonymous rate-limiting on Ask and Feedback. */
function ensureSessionId(): string {
  if (typeof window === "undefined") return "anon";
  try {
    const existing = window.localStorage.getItem(SESSION_KEY);
    if (existing !== null && existing !== "") return existing;
    const fresh = globalThis.crypto.randomUUID();
    window.localStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    return "anon";
  }
}

// ------------------------------------------------------------------- glyphs

function CompassGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 12 15.5 8.5 13 12.5 12 12ZM12 12 8.5 15.5 11 11.5 12 12Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="var(--accent-deep)" />
      <path
        d="M6 10.5 9 13.5 14 7.5"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RingIcon({ gold }: { gold?: boolean }) {
  const color = gold ? "var(--gold)" : "var(--accent)";
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle cx="10" cy="10" r="8" fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}

function DotIcon({ gold }: { gold?: boolean }) {
  const color = gold ? "var(--gold)" : "var(--muted)";
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle cx="10" cy="10" r="3" fill={color} opacity={gold ? 0.7 : 0.5} />
    </svg>
  );
}

// ------------------------------------------------------------------- checklist

function Checklist({ step }: { step: CoachStep }) {
  return (
    <ul className="mt-4 space-y-2">
      {COACH_CHECKLIST.map((row, i) => {
        const done = i < step.index;
        const current = i === step.index;
        return (
          <li
            key={row.id}
            className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
              current ? "bg-accent-deep/40" : ""
            }`}
          >
            <span className="shrink-0">
              {done ? (
                <CheckIcon />
              ) : current ? (
                <RingIcon gold={row.gold} />
              ) : (
                <DotIcon gold={row.gold} />
              )}
            </span>
            <span
              className={`${
                row.gold
                  ? "text-gold"
                  : current
                    ? "font-semibold text-foreground"
                    : done
                      ? "text-muted"
                      : "text-muted/70"
              }`}
            >
              {row.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------------- coach tab

function CoachTab({
  step,
  onPrimary,
  onSecondary,
  funding,
}: {
  step: CoachStep;
  onPrimary: () => void;
  onSecondary: () => void;
  funding: boolean;
}) {
  const copy = coachCopy(step.id);
  const busy = step.loading || (step.id === "getUsdc" && funding);
  const primaryLabel =
    step.id === "getUsdc" && funding ? "Getting..." : copy.primary;

  return (
    <div>
      <p className="text-sm font-semibold text-accent">{copy.headline}</p>
      <p className="mt-1 text-sm leading-relaxed text-muted">{copy.body}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onPrimary}
          disabled={busy}
          className="min-h-11 rounded-lg bg-accent-strong px-4 py-2 text-sm font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {primaryLabel}
        </button>
        {copy.secondary !== undefined ? (
          <button
            type="button"
            onClick={onSecondary}
            className="min-h-11 rounded-lg border border-edge px-4 py-2 text-sm font-medium text-muted hover:text-foreground"
          >
            {copy.secondary}
          </button>
        ) : null}
      </div>

      {step.loading ? (
        <p className="mt-2 animate-pulse text-xs text-muted">
          Checking your balance...
        </p>
      ) : null}

      <Checklist step={step} />
    </div>
  );
}

// ------------------------------------------------------------------- ask tab

function AskTab({ address }: { address: Address | null }) {
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, asking]);

  const submit = useCallback(async () => {
    const question = input.trim();
    if (question === "" || asking) return;
    setError(null);
    setMessages((m) => [...m, { role: "you", text: question }]);
    setInput("");
    setAsking(true);
    try {
      const res = await fetch("/api/help/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          session: ensureSessionId(),
          ...(address !== null ? { address } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        answer?: string;
        remaining?: number;
        error?: string;
      };
      if (res.status === 429) {
        setError(data.error ?? "You have used your questions for now.");
      } else if (!res.ok || typeof data.answer !== "string") {
        setError(data.error ?? "Something went wrong. Try again in a moment.");
      } else {
        setMessages((m) => [...m, { role: "spotter", text: data.answer as string }]);
        if (typeof data.remaining === "number") setRemaining(data.remaining);
      }
    } catch {
      setError("Could not reach the helper. Check your connection.");
    } finally {
      setAsking(false);
    }
  }, [input, asking, address]);

  const left = remaining ?? ASK_PER_SESSION_CAP;

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        className="min-h-32 flex-1 space-y-3 overflow-y-auto pr-1"
      >
        {messages.length === 0 ? (
          <p className="text-sm leading-relaxed text-muted">
            Ask anything about using GoHealthMe - signing in, test USDC, pools,
            proof, getting paid, or how your data stays private. I only cover
            using the app.
          </p>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={m.role === "you" ? "text-right" : "text-left"}
            >
              <span
                className={`inline-block max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                  m.role === "you"
                    ? "bg-accent-deep text-foreground"
                    : "bg-surface-raised text-muted"
                }`}
              >
                {m.text}
              </span>
            </div>
          ))
        )}
        {asking ? (
          <p className="animate-pulse text-sm text-muted">thinking...</p>
        ) : null}
      </div>

      {error !== null ? (
        <p className="mt-2 text-xs text-warning">{error}</p>
      ) : null}

      <div className="mt-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          maxLength={MAX_QUESTION_CHARS}
          rows={2}
          placeholder="How do I get paid?"
          className="w-full resize-none rounded-lg border border-edge bg-surface-raised px-3 py-2 text-sm text-foreground placeholder:text-muted/60 focus:border-accent/60 focus:outline-none"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-muted">{left} of {ASK_PER_SESSION_CAP} left</span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={asking || input.trim() === ""}
            className="min-h-11 rounded-lg bg-accent-strong px-4 py-2 text-sm font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- feedback tab

function FeedbackTab({
  address,
  pathname,
}: {
  address: Address | null;
  pathname: string;
}) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (rating === null && message.trim() === "") {
      setError("Add a rating or a note.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(rating !== null ? { rating } : {}),
          ...(message.trim() !== "" ? { message: message.trim() } : {}),
          ...(address !== null ? { address } : {}),
          page: pathname,
          session: ensureSessionId(),
        }),
      });
      if (res.ok) {
        setDone(true);
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Could not send that. Try again in a moment.");
      }
    } catch {
      setError("Could not reach the server. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }, [rating, message, address, pathname]);

  if (done) {
    return (
      <div className="rounded-xl border border-accent/40 bg-surface-raised p-4">
        <p className="text-sm font-semibold text-accent">Thanks - noted</p>
        <p className="mt-1 text-sm text-muted">
          Your note went straight to the founders. It helps more than you know.
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm leading-relaxed text-muted">
        How was getting started?
      </p>
      <div className="mt-3 flex gap-2">
        {(["easy", "confusing"] as Rating[]).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRating(r)}
            className={`min-h-11 flex-1 rounded-lg border px-3 py-2 text-sm font-medium capitalize ${
              rating === r
                ? "border-accent/60 bg-accent-deep text-accent"
                : "border-edge bg-surface-raised text-muted hover:text-foreground"
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-muted">
        What tripped you up?
      </label>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        maxLength={1000}
        rows={3}
        placeholder="Optional - anything that was unclear"
        className="mt-1 w-full resize-none rounded-lg border border-edge bg-surface-raised px-3 py-2 text-sm text-foreground placeholder:text-muted/60 focus:border-accent/60 focus:outline-none"
      />

      {error !== null ? (
        <p className="mt-2 text-xs text-warning">{error}</p>
      ) : null}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="mt-3 min-h-11 w-full rounded-lg bg-accent-strong px-4 py-2 text-sm font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Sending..." : "Send feedback"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- the widget

const TABS: { id: Tab; label: string }[] = [
  { id: "coach", label: "Coach" },
  { id: "ask", label: "Ask" },
  { id: "feedback", label: "Feedback" },
];

export default function HelperWidget() {
  const { authenticated, address, login } = useEmbeddedWallet();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { fund, funding } = useTestUsdcFunding();

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("coach");

  // First-visit auto-open, client-only. Reads localStorage in an effect (not a
  // lazy initializer) on purpose: the server renders the closed bubble, so the
  // panel only opens after hydration and there is no server/client mismatch.
  useEffect(() => {
    const persisted = readPersisted();
    if (persisted.autoOpened !== true && persisted.dismissed !== true) {
      writePersisted({ ...persisted, autoOpened: true });
      // Syncing from an external store (localStorage) after hydration is the
      // intended use of an effect here, and opening post-hydration is what
      // avoids a server/client mismatch; the heuristic cannot tell.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen(true);
    }
  }, []);

  // Same key + fn as TestUsdcChip: the cache is shared, so no double fetch.
  const balanceQuery = useQuery({
    queryKey: ["wallet-usdc", address],
    queryFn: () => fetchWalletUsdc(address as Address),
    enabled: authenticated && address !== null,
    staleTime: 15_000,
    retry: false,
  });

  const handleQuery = useQuery({
    queryKey: ["help-handle", address],
    enabled: authenticated && address !== null,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<boolean> => {
      const res = await fetch(`/api/social/resolve?addresses=${address}`);
      if (!res.ok) return false;
      const data = (await res.json()) as {
        profiles?: Record<string, unknown>;
      };
      const key = (address as string).toLowerCase();
      return data.profiles !== undefined && data.profiles[key] !== undefined;
    },
  });

  const step = useMemo(
    () =>
      resolveCoachStep({
        authenticated,
        balance: authenticated && address !== null ? balanceQuery.data : 0n,
        handleClaimed: handleQuery.data === true,
        pathname,
      }),
    [authenticated, address, balanceQuery.data, handleQuery.data, pathname],
  );

  const onPrimary = useCallback(() => {
    switch (step.id) {
      case "signIn":
        login();
        break;
      case "getUsdc":
        if (address !== null) {
          void (async () => {
            await fund(address);
            await queryClient.invalidateQueries({
              queryKey: ["wallet-usdc", address],
            });
          })();
        }
        break;
      case "claimHandle":
        setOpen(false);
        router.push("/handle");
        break;
      case "doTheThing":
        setOpen(false);
        router.push("/challenge/new");
        break;
      case "uploadProof":
        document
          .getElementById("proof-upload")
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
        setOpen(false);
        break;
    }
  }, [step.id, login, address, fund, queryClient, router]);

  const onSecondary = useCallback(() => {
    setOpen(false);
    router.push("/pools");
  }, [router]);

  const close = useCallback(() => {
    setOpen(false);
    writePersisted({ ...readPersisted(), dismissed: true });
  }, []);

  const pending = step.id !== "doTheThing";

  if (!open) {
    return (
      <button
        type="button"
        aria-label="Open the GoHealthMe helper"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-accent-strong text-background shadow-lg shadow-black/40 hover:bg-accent"
      >
        <CompassGlyph />
        {pending ? (
          <span className="absolute right-1 top-1 h-3 w-3 rounded-full border-2 border-background bg-gold" />
        ) : null}
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-h-[70vh] w-[calc(100vw-2rem)] max-w-[360px] flex-col rounded-2xl border border-edge bg-surface shadow-xl shadow-black/50">
      <div className="flex items-center justify-between border-b border-edge px-4 py-3">
        <div className="flex items-center gap-2 text-accent">
          <CompassGlyph />
          <span className="text-sm font-semibold text-foreground">
            Getting started
          </span>
        </div>
        <button
          type="button"
          aria-label="Close the helper"
          onClick={close}
          className="rounded-lg px-2 py-1 text-lg leading-none text-muted hover:text-foreground"
        >
          &times;
        </button>
      </div>

      <div className="flex gap-1 px-3 pt-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
              tab === t.id
                ? "bg-accent-deep text-accent"
                : "text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {tab === "coach" ? (
          <CoachTab
            step={step}
            onPrimary={onPrimary}
            onSecondary={onSecondary}
            funding={funding}
          />
        ) : tab === "ask" ? (
          <AskTab address={address} />
        ) : (
          <FeedbackTab address={address} pathname={pathname} />
        )}
      </div>
    </div>
  );
}
