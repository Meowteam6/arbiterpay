"use client";

// Claim (or change) the handle for the connected wallet. The write is proven
// by a wallet signature: fetchWithWalletAuth attaches the EIP-191 headers the
// server verifies before it touches the profiles table. No transaction is
// sent and nothing is charged - the signature only proves the wallet is yours.

import { useState } from "react";
import Link from "next/link";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import { useEmbeddedWallet } from "@/lib/wallet";
import { useWalletAuth } from "@/lib/useWalletAuth";
import { authBlockReason, fetchWithWalletAuth } from "@/lib/client-auth";
import { checkEmoji, checkHandle, HANDLE_MAX, EMOJI_MAX } from "@/lib/social";
import { ErrorNote } from "@/components/ui";

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "done"; handle: string }
  | { kind: "error"; message: string };

function ClaimHandleInner() {
  const { ready, authenticated, address, login } = useEmbeddedWallet();
  const requestAuth = useWalletAuth();
  const [handle, setHandle] = useState("");
  const [emoji, setEmoji] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const submit = async () => {
    setFormError(null);

    const handleCheck = checkHandle(handle);
    if (!handleCheck.ok) {
      setFormError(handleCheck.reason);
      return;
    }
    const emojiCheck = checkEmoji(emoji);
    if (!emojiCheck.ok) {
      setFormError(emojiCheck.reason);
      return;
    }
    if (address === null) {
      setFormError("Connect your wallet first.");
      return;
    }

    setStatus({ kind: "saving" });
    try {
      const sent = await fetchWithWalletAuth(
        "/api/social/handle",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            address,
            handle: handleCheck.handle,
            emoji: emojiCheck.emoji,
          }),
        },
        requestAuth,
      );

      if (!sent.response.ok) {
        if (sent.auth.kind !== "ok") {
          setStatus({
            kind: "error",
            message:
              authBlockReason(sent.auth) ??
              "Sign with your wallet to claim this handle.",
          });
          return;
        }
        const body = (await sent.response.json().catch(() => ({}))) as {
          error?: string;
        };
        setStatus({
          kind: "error",
          message: body.error ?? "Could not save the handle.",
        });
        return;
      }

      setStatus({ kind: "done", handle: handleCheck.handle });
    } catch {
      setStatus({
        kind: "error",
        message: "Could not reach the server. Try again.",
      });
    }
  };

  if (status.kind === "done") {
    return (
      <div className="space-y-3 rounded-2xl border border-accent/40 bg-accent-deep/40 p-5">
        <p className="text-base font-semibold text-accent">
          Handle claimed as @{status.handle}
        </p>
        <p className="text-sm text-foreground/80">
          Your public page is live. Share it - it shows your verified wins and
          payouts, never the health category behind them.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href={`/u/${status.handle}`}
            className="rounded-xl bg-accent-strong px-5 py-3 text-sm font-semibold text-background hover:bg-accent"
          >
            View your page
          </Link>
          <button
            type="button"
            onClick={() => {
              setStatus({ kind: "idle" });
              setHandle("");
              setEmoji("");
            }}
            className="rounded-xl border border-edge px-5 py-3 text-sm font-medium text-muted hover:text-foreground"
          >
            Change it
          </button>
        </div>
      </div>
    );
  }

  const saving = status.kind === "saving";

  return (
    <div className="space-y-4">
      <label className="block text-sm font-medium">
        Handle
        <div className="mt-1 flex items-center rounded-xl border border-edge bg-surface-raised px-3">
          <span className="text-muted">@</span>
          <input
            type="text"
            value={handle}
            maxLength={HANDLE_MAX}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="ironhabit"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="w-full bg-transparent px-1 py-3 text-base outline-none"
          />
        </div>
        <span className="mt-1 block text-xs text-muted">
          Lowercase letters, numbers, and underscores. 3 to {HANDLE_MAX}{" "}
          characters.
        </span>
      </label>

      <label className="block text-sm font-medium">
        Avatar glyph (optional)
        <input
          type="text"
          value={emoji}
          maxLength={EMOJI_MAX}
          onChange={(e) => setEmoji(e.target.value)}
          placeholder="a single character"
          className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
        />
      </label>

      <button
        type="button"
        disabled={!ready || saving}
        onClick={() => {
          if (!authenticated) {
            login();
            return;
          }
          void submit();
        }}
        className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving
          ? "Signing and saving..."
          : authenticated
            ? "Claim handle"
            : "Sign in to claim"}
      </button>

      <p className="text-xs text-muted">
        Claiming signs a message to prove the wallet is yours. Nothing is
        charged and no transaction is sent.
      </p>

      {formError !== null ? (
        <ErrorNote
          title="Check the handle"
          detail={formError}
          onRetry={() => setFormError(null)}
        />
      ) : null}

      {status.kind === "error" ? (
        <ErrorNote
          title="Could not claim the handle"
          detail={status.message}
          onRetry={() => setStatus({ kind: "idle" })}
        />
      ) : null}
    </div>
  );
}

export default function ClaimHandle() {
  if (!DYNAMIC_CONFIGURED) {
    return (
      <ErrorNote
        title="Sign-in is not configured"
        detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable handle claiming."
      />
    );
  }
  return <ClaimHandleInner />;
}
