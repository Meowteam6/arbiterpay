import Link from "next/link";
import GoalIntent from "@/components/GoalIntent";

const steps = [
  {
    title: "Say what you are going to do",
    body: "Sleep streak, flu shot, back in the gym. A sponsor's USDC is already staked behind it - not yours.",
  },
  {
    title: "SPOTTER buys the proof-check",
    body: "An agent with its own wallet buys whatever verification your claim needs, per claim, under a hard budget. Every cent prints on screen.",
  },
  {
    title: "Paid the second it is proven",
    body: "The verdict comes out of a confidential enclave - nobody ever sees your health data - and SPOTTER pays you from its own wallet. No human in the loop.",
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
          buys whatever it needs to check your proof, decides, and pays you out
          of its own wallet. No human in the loop, and nobody ever sees your
          health data.
        </p>
        <GoalIntent />
        <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/pools"
            className="text-sm font-medium text-muted underline-offset-4 hover:text-foreground hover:underline"
          >
            or browse the live pools
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
