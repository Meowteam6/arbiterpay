import type { Metadata } from "next";
import GoalMatch from "@/components/GoalMatch";

export const metadata: Metadata = {
  title: "Your goal — GoHealthMe",
  description: "Live sponsor-funded pools matched to the goal you typed.",
};

export default async function GoalPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return <GoalMatch query={q ?? ""} />;
}
