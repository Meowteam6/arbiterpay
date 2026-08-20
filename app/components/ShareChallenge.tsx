"use client";

// Web Share + SMS + email + copy for a challenge link. One primitive so the
// create screen (send the dare to the one target) and the landing (rally
// friends to chip in) share identical share plumbing.
//
// navigator.share is FEATURE-DETECTED and only rendered when the browser has
// it - typically mobile. The sms:/mailto: rows and copy are the universal
// fallback that works on desktop and every browser without the Web Share API.
// Every path carries the same body: the caller's message with the link
// appended, so the recipient always gets the link no matter which button was
// tapped.
//
// PRIVACY: the body is composed by the caller and sent by the user to a
// recipient THEY pick (the share sheet, their own contacts). It is never
// posted to a public surface. The one place that must not leak is the link
// preview, and that is handled on the landing page itself (noindex, neutral
// title).

import { useEffect, useState, useSyncExternalStore } from "react";
import { challengeShareUrl } from "@/lib/challenges";
import { TAP_TARGET } from "@/components/ui";

type CopyState = "idle" | "copied" | "failed";

const subscribeNoop = () => () => {};

// True on the client (after hydration), false on the server and during the
// hydrating render. useSyncExternalStore is the hydration-safe way to gate
// client-only rendering, so the origin- and navigator-derived values below are
// computed during render rather than pushed through a setState-in-effect.
function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

// `sms:?&body=` is the cross-platform prefill both iOS and Android accept, with
// no recipient set so the sender chooses who it goes to.
function smsHref(body: string): string {
  return `sms:?&body=${encodeURIComponent(body)}`;
}

function mailtoHref(subject: string, body: string): string {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default function ShareChallenge({
  url,
  token,
  title,
  message,
  emailSubject,
  includeCopy = true,
  shareLabel = "Share",
}: {
  /** A ready full URL (the create screen has it in hand). */
  url?: string;
  /** Or a token to compose the URL from window.location.origin (the landing,
   *  a server component, has the token but not the client origin). */
  token?: string;
  /** Native-share title and email subject. */
  title: string;
  /** The message body WITHOUT the link; the link is appended for every path. */
  message: string;
  emailSubject: string;
  /** Hide the copy button when the caller already shows its own (the create
   *  screen keeps its full-link CopyLink as the fallback). */
  includeCopy?: boolean;
  shareLabel?: string;
}) {
  const isClient = useIsClient();
  const [copy, setCopy] = useState<CopyState>("idle");

  useEffect(() => {
    if (copy === "idle") return;
    const timer = setTimeout(() => setCopy("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copy]);

  // A ready url is used directly (the create screen has it); otherwise the url
  // is composed from the token and the client origin, which only exists after
  // hydration. Both derive during render - hydration-safe via useIsClient.
  const resolvedUrl =
    url ??
    (isClient && token !== undefined && typeof window !== "undefined"
      ? challengeShareUrl(window.location.origin, token)
      : null);

  const canNativeShare =
    isClient &&
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function";

  if (resolvedUrl === null) return null;
  const body = `${message} ${resolvedUrl}`;

  const nativeShare = () => {
    // A user dismissing the share sheet rejects the promise; that is a normal
    // cancel, not an error to surface.
    void navigator
      .share({ title, text: message, url: resolvedUrl })
      .catch(() => {});
  };

  const runCopy = () => {
    const clipboard =
      typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      setCopy("failed");
      return;
    }
    clipboard.writeText(resolvedUrl).then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {canNativeShare ? (
          <button
            type="button"
            onClick={nativeShare}
            className={`flex-1 rounded-xl bg-accent-strong font-semibold text-background hover:bg-accent ${TAP_TARGET}`}
          >
            {shareLabel}
          </button>
        ) : null}
        <a
          href={smsHref(body)}
          className={`flex-1 rounded-xl border border-accent/50 bg-surface-raised text-center font-semibold text-accent hover:bg-accent-deep ${TAP_TARGET}`}
        >
          Text
        </a>
        <a
          href={mailtoHref(emailSubject, body)}
          className={`flex-1 rounded-xl border border-accent/50 bg-surface-raised text-center font-semibold text-accent hover:bg-accent-deep ${TAP_TARGET}`}
        >
          Email
        </a>
        {includeCopy ? (
          <button
            type="button"
            onClick={runCopy}
            className={`flex-1 rounded-xl border border-edge bg-surface-raised font-semibold text-muted hover:text-foreground ${TAP_TARGET}`}
          >
            <span aria-live="polite">
              {copy === "copied"
                ? "Copied"
                : copy === "failed"
                  ? "Copy failed"
                  : "Copy link"}
            </span>
          </button>
        ) : null}
      </div>
      {copy === "failed" ? (
        <p aria-live="polite" className="text-xs text-muted">
          Copying is blocked in this browser - use Text or Email, or select the
          link by hand.
        </p>
      ) : null}
    </div>
  );
}
