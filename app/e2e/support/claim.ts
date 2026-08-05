// Driving one claim end to end through the app's own two routes, the same way
// components/EvidenceUpload.tsx and components/WearableCheck.tsx do.

import { expect, type APIRequestContext } from "@playwright/test";
import type { Hex } from "viem";
import type { TestWallet } from "./test";

/** Statuses the run loop stops on. Anything else means "poll again". */
const TERMINAL: readonly string[] = [
  "paid",
  "no-pay",
  "cap-exceeded",
  "blocked",
  "recorded",
  "error",
];

export interface RunResponse {
  status: string;
  access: "owner" | "not-owner" | "unproven";
  hasLedger: boolean;
  claim: {
    goalId: string;
    decision: "pay" | "no-pay" | null;
    spends: Array<{ label: string; amountUsd: string; settlement: string }>;
    recordTxs: { resultTx: string | null; registryTx: string | null } | null;
    settle: { status: string; txHash: string | null; paidUsd: string | null } | null;
  };
  /** Non-null only for a caller who proved control of the participant wallet. */
  ledger: Array<Record<string, unknown>> | null;
}

/** Step 1 of the document flow: hand the enclave the record. */
export async function submitEvidence(
  request: APIRequestContext,
  params: {
    poolId: string;
    address: string;
    body?: string;
    contentType?: string;
  },
): Promise<{ status: number; attesterId?: string; error?: string }> {
  const response = await request.post("/api/evidence/submit", {
    data: {
      poolId: params.poolId,
      address: params.address,
      // Accepted for wire compatibility and deliberately ignored server-side:
      // the pool's on-chain goalSpec is the only goal the enclave ever judges.
      goalSpec: "whatever the caller feels like claiming",
      fileBase64: Buffer.from(
        params.body ?? "TOTAL CHOLESTEROL 180 mg/dL — within range.",
        "utf8",
      ).toString("base64"),
      fileName: "ignored-by-the-server.txt",
      contentType: params.contentType ?? "text/plain",
    },
  });
  const payload = (await response.json()) as {
    attesterId?: string;
    error?: string;
  };
  return { status: response.status(), ...payload };
}

/**
 * Step 2: drive the run loop to a terminal status, exactly as the browser
 * does — same route, same body, same "poll until it stops moving" contract.
 */
export async function runClaimToCompletion(
  request: APIRequestContext,
  params: {
    goalId: Hex;
    poolId: string;
    wallet: TestWallet;
    attesterId?: string;
    evidenceKind?: "document" | "wearable";
    maxPolls?: number;
  },
): Promise<RunResponse> {
  const maxPolls = params.maxPolls ?? 12;
  let last: RunResponse | null = null;

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const response = await request.post(
      `/api/agent/run/${params.goalId}?poolId=${params.poolId}`,
      {
        // Signed: the run itself never needs a signature, but the ledger comes
        // back redacted without one, and the ledger is where the verdict is.
        headers: await params.wallet.authHeaders(),
        data: {
          poolId: params.poolId,
          address: params.wallet.address,
          ...(params.attesterId !== undefined
            ? { attesterId: params.attesterId }
            : {}),
          ...(params.evidenceKind !== undefined
            ? { evidenceKind: params.evidenceKind }
            : {}),
        },
      },
    );
    expect(
      response.status(),
      `run poll ${attempt} failed: ${await response.text()}`,
    ).toBe(200);
    last = (await response.json()) as RunResponse;
    if (TERMINAL.includes(last.status)) return last;
  }

  throw new Error(
    `claim ${params.goalId} never reached a terminal status (last: ${last?.status})`,
  );
}

/** Find one ledger entry by kind. The ledger is only present for an owner. */
export function ledgerEntry(
  run: RunResponse,
  kind: string,
): Record<string, unknown> {
  const entry = (run.ledger ?? []).find((e) => e.kind === kind);
  if (entry === undefined) {
    throw new Error(
      `no "${kind}" entry in ledger: ${JSON.stringify(run.ledger)}`,
    );
  }
  return entry;
}
