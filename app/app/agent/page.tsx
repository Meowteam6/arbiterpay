import type { Metadata } from "next";
import AgentConsole from "@/components/AgentConsole";

export const metadata: Metadata = {
  title: "SPOTTER — GoHealthMe",
  description:
    "The settlement agent's wallet, budget, and every claim it has touched.",
};

export default function AgentPage() {
  return <AgentConsole />;
}
