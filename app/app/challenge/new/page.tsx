import type { Metadata } from "next";
import CreateChallenge from "@/components/CreateChallenge";

export const metadata: Metadata = {
  title: "Challenge a friend - GoHealthMe",
  description:
    "Dare someone to hit a goal and put real USDC behind it. They hit it, they get paid the second it is verified. Nobody ever sees their health data.",
};

export default function NewChallengePage() {
  return <CreateChallenge />;
}
