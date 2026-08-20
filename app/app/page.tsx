import Link from "next/link";
import GoalIntent from "@/components/GoalIntent";
import { Badge } from "@/components/ui";

const steps = [
  {
    title: "Say what you are going to do",
    body: "Sleep streak, flu shot, back in the gym. A sponsor's USDC is already staked behind it - not yours.",
  },
  {
    title: "SPOTTER buys the proof-check",
    body: "SPOTTER pays for the proof-check itself, per claim, out of its own budget and under a hard cap. Every cent prints on screen.",
  },
  {
    title: "Paid the second it is proven",
    body: "The verdict comes out of a confidential enclave - nobody ever sees your health data - and SPOTTER settles the pool on Arc. The bounty leaves the sponsor's pool and lands in your wallet. SPOTTER covers the gas and the proof-check, not the bounty. No human in the loop.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-col gap-14 py-6 sm:py-12">
      <section className="text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-accent">
          Free money with extra steps. The steps are the point.
        </p>
        <h1 className="mx-auto mt-4 max-w-2xl text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
          Your goal. Somebody else&apos;s money.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-muted">
          Say what you are going to do. A sponsor puts up the USDC. An agent
          buys whatever it needs to check your proof, decides, and releases the
          sponsor&apos;s money to you on the spot. No human in the loop, and
          nobody ever sees your health data.
        </p>
        {/* The one honest line. "Put money on it" read like a bill, and the
            only testnet disclosure in the app used to be on /pools - a
            stranger deserves to know the stakes before they type anything. */}
        <div className="mx-auto mt-6 flex max-w-xl flex-col items-center gap-2 sm:flex-row sm:justify-center">
          <Badge tone="warning">Arc Testnet</Badge>
          <p className="text-sm leading-relaxed text-muted">
            The USDC is test USDC. You put in nothing and nothing here can cost
            you real money.
          </p>
        </div>
        <p className="mx-auto mt-3 max-w-xl text-xs leading-relaxed text-muted">
          Testnet demo, play-money USDC. Not medical or financial advice. See{" "}
          <Link href="/privacy" className="underline hover:text-foreground">
            Privacy
          </Link>{" "}
          and{" "}
          <Link href="/terms" className="underline hover:text-foreground">
            Terms
          </Link>
          .
        </p>
        <GoalIntent />
        <div className="mt-6">
          <Link
            href="/challenge/new"
            className="inline-flex items-center gap-2 rounded-xl border border-accent/50 bg-accent-deep/30 px-6 py-3 text-sm font-semibold text-accent hover:bg-accent-deep/50"
          >
            or dare a friend and put money on it
            <span aria-hidden="true">-&gt;</span>
          </Link>
          <p className="mx-auto mt-2 max-w-md text-xs text-muted">
            You fund the reward, they hit the goal, they get paid. They flake,
            you get it back. Their health data stays private the whole way.
          </p>
        </div>
        <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/pools"
            className="py-2 text-sm font-medium text-muted underline-offset-4 hover:text-foreground hover:underline"
          >
            or browse the live pools
          </Link>
          <Link
            href="/pools/create"
            className="py-2 text-sm font-medium text-muted underline-offset-4 hover:text-foreground hover:underline"
          >
            sponsoring instead? put up a bounty
          </Link>
          <Link
            href="/feed"
            className="py-2 text-sm font-medium text-muted underline-offset-4 hover:text-foreground hover:underline"
          >
            see who got paid
          </Link>
          <Link
            href="/handle"
            className="py-2 text-sm font-medium text-muted underline-offset-4 hover:text-foreground hover:underline"
          >
            claim your handle
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {steps.map((step, i) => (
          <div
            key={step.title}
            className="rounded-2xl border border-edge bg-surface p-6"
          >
            <p className="font-mono text-sm font-bold text-accent">
              0{i + 1}
            </p>
            <h2 className="mt-2 text-lg font-semibold">{step.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {step.body}
            </p>
          </div>
        ))}
      </section>
    </div>
  );
}
