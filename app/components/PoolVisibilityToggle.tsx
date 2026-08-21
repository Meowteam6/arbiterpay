"use client";

// Owner-only control on the pool page: flip a pool between public and private.
//
// On-chain the pool is always public; this writes the app-layer visibility flag
// (lib/server/pool-visibility.ts) behind the same wallet-signature + on-chain
// creator proof the challenge mint uses. Only the creator ever sees this - the
// pool page renders it under `isCreator`.
//
// Making a pool private returns an unguessable /p/[token] link, shown here so
// the owner can hand it out. Making it public drops the pool back onto the
// board and the Payout Feed. NO health data passes through this component: it
// sends only the address and the chosen visibility enum.

import { useState } from "react";
import { useEmbeddedWallet } from "@/lib/wallet";
import { useWalletAuth } from "@/lib/useWalletAuth";
import { authBlockReason, fetchWithWalletAuth } from "@/lib/client-auth";
import ShareChallenge from "@/components/ShareChallenge";
import { ErrorNote, TAP_TARGET } from "@/components/ui";

export default function PoolVisibilityToggle({
  poolId,
  initialPrivate,
}: {
  poolId: bigint;
  /** The pool's current effective visibility (true = private), server-resolved. */
  initialPrivate: boolean;
}) {
  const { address } = useEmbeddedWallet();
  const requestAuth = useWalletAuth();

  const [isPrivate, setIsPrivate] = useState(initialPrivate);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flip = async () => {
    if (address === null) {
      setError("Connect your wallet to change this.");
      return;
    }
    setBusy(true);
    setError(null);
    const target = isPrivate ? "public" : "private";
    try {
      const sent = await fetchWithWalletAuth(
        `/api/pools/${poolId.toString()}/visibility`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, visibility: target }),
        },
        requestAuth,
      );

      if (!sent.response.ok) {
        if (sent.auth.kind !== "ok") {
          setError(
            authBlockReason(sent.auth) ??
              "Sign with your wallet to change this pool.",
          );
          return;
        }
        const body = (await sent.response.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(body.error ?? "Could not change the pool's visibility.");
        return;
      }

      const body = (await sent.response.json()) as {
        visibility?: string;
        sharePath?: string | null;
      };
      const nowPrivate = body.visibility === "private";
      setIsPrivate(nowPrivate);
      if (
        nowPrivate &&
        typeof body.sharePath === "string" &&
        body.sharePath !== ""
      ) {
        const origin =
          typeof window === "undefined" ? "" : window.location.origin;
        setShareUrl(`${origin}${body.sharePath}`);
      } else {
        setShareUrl(null);
      }
    } catch {
      setError("Could not change the pool's visibility. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-edge bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            Visibility - only you see this
          </p>
          <p className="mt-1 text-base font-semibold">
            {isPrivate ? "Private" : "Public"}
          </p>
          <p className="mt-1 text-sm text-muted">
            {isPrivate
              ? "Unlisted. It stays off the pools board and the payout feed, reachable only by the private link below."
              : "Listed on the pools board, and paid claims show on the public feed."}
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void flip()}
          className={`rounded-xl border border-accent/50 bg-accent-deep/30 font-semibold text-accent hover:bg-accent-deep/50 disabled:cursor-not-allowed disabled:opacity-60 ${TAP_TARGET}`}
        >
          {busy
            ? "Saving..."
            : isPrivate
              ? "Make public"
              : "Make private"}
        </button>
      </div>

      {isPrivate && shareUrl !== null ? (
        <div className="space-y-2 rounded-xl border border-accent/30 bg-accent-deep/20 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            Private link
          </p>
          <p className="break-all font-mono text-xs text-foreground/80">
            {shareUrl}
          </p>
          <ShareChallenge
            url={shareUrl}
            title="A private pool on GoHealthMe"
            message="Here is the private link to my pool on GoHealthMe:"
            emailSubject="A private pool on GoHealthMe"
            shareLabel="Share the link"
          />
          <p className="text-xs text-muted">
            Anyone with this link can open the pool, so send it only to the
            people it is for. It is not listed anywhere and cannot be guessed.
          </p>
        </div>
      ) : null}

      {error !== null ? (
        <ErrorNote
          title="Could not change visibility"
          detail={error}
          onRetry={() => setError(null)}
        />
      ) : null}
    </section>
  );
}
