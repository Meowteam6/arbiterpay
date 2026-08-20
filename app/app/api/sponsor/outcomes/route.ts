// Server-side sponsor outcome aggregation.
//
// fetchPoolEventTotals does a historical eth_getLogs scan that the BROWSER RPCs
// cannot serve: the primary Arc RPC prunes deploy-era history and the archival
// public one caps getLogs well below a full scan and rate-limits bursts. Run it
// here instead, where getArcPublicClient() uses the archival ARC_RPC_URL
// override that can serve the logs, then hand the client JSON-safe totals
// (bigints as strings). If even the archival scan cannot complete,
// fetchPoolEventTotals degrades to {} and the console lists pools with outcomes
// pending rather than failing.

import { NextResponse } from "next/server";
import { fetchPoolEventTotals } from "@/lib/sponsor-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SerializedTotals {
  joined: number;
  completions: number;
  paidUsdc: string;
  toppedUpUsdc: string;
}

export async function GET() {
  try {
    const totals = await fetchPoolEventTotals();
    const out: Record<string, SerializedTotals> = {};
    for (const [poolId, t] of Object.entries(totals)) {
      out[poolId] = {
        joined: t.joined,
        completions: t.completions,
        paidUsdc: t.paidUsdc.toString(),
        toppedUpUsdc: t.toppedUpUsdc.toString(),
      };
    }
    return NextResponse.json({ totals: out });
  } catch {
    return NextResponse.json({ totals: {} });
  }
}
