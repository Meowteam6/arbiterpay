"use client";

// Email-first sign-in for an inline gated control.
//
// Wrap this around any CTA a signed-out user can tap that needs a wallet. It
// renders the gate's own button (passed as a function child that receives an
// openSignIn callback); the button's not-authenticated branch calls openSignIn,
// which swaps the button for the email-first SignInPanel in place. That keeps
// the provisioned embedded wallet the default everywhere a user can first
// authenticate: the panel runs the email code flow and never opens Dynamic's
// raw wallet modal, so an injected extension cannot intercept the default path
// the way a bare login() -> setShowAuthFlow(true) does. Reaching an external
// wallet stays a deliberate second choice inside the panel.
//
// The panel shows only while signed out. The instant Dynamic reports an
// authenticated session the button returns, now wired to its real action, so a
// freshly signed-in user taps once more to run it - the same two-step the
// dashboard empty state already uses.

import { useState, type ReactNode } from "react";
import { useEmbeddedWallet } from "@/lib/wallet";
import SignInPanel from "@/components/SignInPanel";

export default function SignInGate({
  note,
  children,
}: {
  note?: string;
  children: (openSignIn: () => void) => ReactNode;
}) {
  const { authenticated } = useEmbeddedWallet();
  const [open, setOpen] = useState(false);

  if (open && !authenticated) {
    return (
      <div className="space-y-2">
        {note !== undefined ? (
          <p className="text-sm text-muted">{note}</p>
        ) : null}
        <SignInPanel />
      </div>
    );
  }

  return <>{children(() => setOpen(true))}</>;
}
