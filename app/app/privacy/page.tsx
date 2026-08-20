import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui";

export const metadata: Metadata = {
  title: "Privacy - GoHealthMe",
  description:
    "What GoHealthMe collects, how it is used, and who processes it. A plain-language, pre-launch testnet notice.",
};

const EFFECTIVE_DATE = "2026-08-20";
const CONTACT_EMAIL = "andre102599@gmail.com";

/**
 * Pre-counsel, testnet-only privacy notice. Every statement here is written to
 * match what the app actually does (see lib/server/judge.ts for the TEE
 * boundary, lib/server/junction.ts for the wearable path, lib/server/help/ask.ts
 * for the Gemini call, and contracts/src/HealthPools.sol for the on-chain
 * goalSpec). Do not add claims the app cannot keep.
 */
export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-3xl py-4">
      <header className="space-y-3">
        <Badge tone="warning">Testnet demo</Badge>
        <h1 className="text-3xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="text-sm text-muted">
          Effective {EFFECTIVE_DATE}. This is a pre-launch notice for a testnet
          demo, written in plain language so you know what happens to your data
          before you try the app.
        </p>
      </header>

      <div className="mt-6 rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm leading-relaxed text-foreground/90">
        This is not legal advice. It is an honest, good-faith description of a
        pre-launch testnet demo, not a finished legal policy. Before any
        real-money launch it will be replaced by a policy reviewed by a lawyer.
      </div>

      <div className="mt-10 space-y-10 text-sm leading-relaxed text-muted">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            This is a testnet demo
          </h2>
          <p>
            GoHealthMe runs on the Arc testnet. All USDC here is test USDC with
            no real monetary value. Nothing on this site can pay you real money
            or cost you real money.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            Signing in creates a wallet
          </h2>
          <p>
            When you sign in with your email, Dynamic (a Fireblocks company)
            creates an embedded wallet for you on Arc. From that step we hold
            your email address and your wallet address.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            Your handle is public on purpose
          </h2>
          <p>
            Claiming a handle is optional. If you do, your @handle, the emoji
            you pick, and your public page at /u/your-handle become visible to
            anyone. That page shows your verified wins and payouts, never the
            health category behind them. Handles are stored in our database
            (Supabase) and are public by design.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            Challenges and feedback
          </h2>
          <p>
            If you create or accept a challenge, we store its metadata in
            Supabase: an invite token, the pool id, an optional label for who
            the challenge is for, and an optional message. If you leave
            feedback, we store your rating and your message.
          </p>
          <p>
            One thing to be clear about: the health goal text you write when you
            create a pool or a challenge (for example, &quot;lose 10 lbs&quot;)
            is written on-chain in the pool&apos;s goal description, not just in
            our database. See the on-chain section below.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            The Ask helper sends your question to Google
          </h2>
          <p>
            When you type a question into the in-app helper, that question is
            sent to Google&apos;s Gemini model (via Vertex AI on Google Cloud)
            so it can answer questions about how the app works. Only the text
            you type is sent. We do not send your health data, your pool
            activity, or your wallet address.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            Document proof stays inside a secure enclave
          </h2>
          <p>
            When you verify a goal by uploading a document (a lab result, a
            flu-shot record, a screening result), the file is sent to a
            confidential trusted execution environment (a secure enclave) so the
            verification model can read it. Only the signed yes-or-no verdict
            leaves the enclave. The document itself is not written to our
            database or to the blockchain.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            Wearable data is handled differently, and we want to be straight
            about it
          </h2>
          <p>
            If you connect a wearable through Junction (WHOOP, Oura, Fitbit, or
            Garmin), the health summary we pull to check a streak passes through
            our own server (hosted on Vercel) before we compute the result. It
            does not go through the secure enclave.
          </p>
          <p>
            So the &quot;nobody ever sees your health data&quot; claim is true
            for the document path and not for the wearable path. We do not write
            wearable summaries to the blockchain, but our server does handle
            them to run the check. If that matters to you, use the document
            path instead of connecting a wearable.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            Some things are public and permanent by design
          </h2>
          <p>
            GoHealthMe settles on the Arc testnet blockchain. Wallet addresses,
            pool activity, payouts, and the goal text you write when you create
            a pool are recorded on-chain. Blockchain records are public and, by
            their nature, permanent. We cannot edit or delete them. Do not put
            anything in a goal description that you would not want to be public
            forever.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            Who processes your data
          </h2>
          <p>
            We rely on the following third parties to run the demo. Each is
            named so you can read their own policies:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Dynamic (a Fireblocks company) - email sign-in and embedded wallets</li>
            <li>Circle - the agent wallet and USDC settlement</li>
            <li>Supabase - our database (handles, challenge metadata, feedback)</li>
            <li>Google Cloud / Vertex AI - the Gemini model that answers helper questions</li>
            <li>Vercel - hosting for the app and its server</li>
            <li>Arc testnet - the public blockchain where pools settle</li>
            <li>Junction - wearable summaries, only if you connect a device</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            How long we keep it
          </h2>
          <p>
            We keep off-chain data (handles, challenge metadata, feedback) until
            you ask us to delete it, or until we reset the testnet. Testnet data
            may be wiped at any time. On-chain data is permanent and outside our
            control to delete.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">Contact</h2>
          <p>
            This demo is operated by Meowteam6. To ask a question or request
            deletion of your off-chain data, email{" "}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-accent underline"
            >
              {CONTACT_EMAIL}
            </a>{" "}
            (contact address to be confirmed).
          </p>
        </section>

        <section className="space-y-3 border-t border-edge pt-8">
          <p className="text-xs text-muted">
            This is a pre-launch testnet notice, not legal advice, and will be
            replaced by a lawyer-reviewed policy before any real-money launch.
            See also our{" "}
            <Link href="/terms" className="text-accent underline">
              Terms
            </Link>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
