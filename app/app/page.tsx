import Link from "next/link";
import GoalIntent from "@/components/GoalIntent";
import { Badge, Money } from "@/components/ui";

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
      <section className="grid items-center gap-10 lg:grid-cols-[1.1fr_0.9fr]">
        {/* Left: the pitch. Every functional control stays; only the layout
            goes asymmetric so SPOTTER gets to share the hero. */}
        <div className="text-center lg:text-left">
          <p className="text-sm font-semibold uppercase tracking-widest text-accent-strong">
            Free money with extra steps. The steps are the point.
          </p>
          <h1 className="mt-4 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            Your goal. Somebody else&apos;s money.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-muted lg:mx-0">
            Say what you are going to do. A sponsor puts up the USDC. An agent
            buys whatever it needs to check your proof, decides, and releases the
            sponsor&apos;s money to you on the spot. No human in the loop, and
            nobody ever sees your health data.
          </p>
          {/* The one honest line. "Put money on it" read like a bill, and the
              only testnet disclosure in the app used to be on /pools - a
              stranger deserves to know the stakes before they type anything. */}
          <div className="mt-6 flex flex-col items-center gap-2 sm:flex-row sm:justify-center lg:justify-start">
            <Badge tone="muted">Arc Testnet</Badge>
            <p className="text-sm leading-relaxed text-muted">
              The USDC is test USDC. You put in nothing and nothing here can cost
              you real money.
            </p>
          </div>
          <p className="mt-3 max-w-xl text-xs leading-relaxed text-muted">
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
              className="inline-flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-6 py-3 text-sm font-semibold text-accent-strong hover:bg-accent/15"
            >
              or dare a friend and put money on it
              <span aria-hidden="true">-&gt;</span>
            </Link>
            <p className="mt-2 max-w-md text-xs text-muted">
              You fund the reward, they hit the goal, they get paid. They flake,
              you get it back. Their health data stays private the whole way.
            </p>
          </div>
          <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:flex-wrap sm:justify-center lg:justify-start">
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
        </div>

        {/* Right: Mr Otter and the payout moment. */}
        <div className="relative mx-auto w-full max-w-sm">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-4 -z-10 rounded-full bg-accent/20 blur-3xl"
          />
          <div className="otter-float relative overflow-hidden rounded-3xl border border-edge bg-surface shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/spotter/spotter-nature.png"
              alt="SPOTTER, the GoHealthMe otter, standing on a mossy rock by a sunlit riverbank"
              className="aspect-square w-full object-cover"
            />
            <div className="p-5">
              <p className="text-base font-semibold">Meet SPOTTER</p>
              <p className="mt-1 text-sm text-muted">
                The agent that holds the money, checks your proof, and pays you.
              </p>
            </div>
          </div>
          <div className="absolute -bottom-5 -left-3 flex flex-col gap-0.5 rounded-2xl border border-gold/40 bg-surface px-4 py-3 shadow-md sm:-left-6">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              SPOTTER paid you
            </span>
            <Money usd="50.00" sign="+" size="lg" tone="gold" />
          </div>
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
