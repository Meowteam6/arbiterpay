"use client";

// The most protected surface in the build: SPOTTER's per-claim receipt.
// Every row maps one-to-one onto a ledger entry via projectReceipt - planned
// steps print before their prices, the escalation prints unplanned at its
// chronological position, and the running total stands against the frozen
// cap. Nothing renders here that did not go through the ledger first.

import { projectReceipt, type LedgerEntry } from "@/lib/agent-receipt";
import { ArcTxLink, Money, Verdict } from "@/components/ui";

function SpendRow({
  row,
}: {
  row: Extract<ReturnType<typeof projectReceipt>["rows"][number], { kind: "spend" }>;
}) {
  return (
    <li className="animate-rise-in">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">
          {row.paidUsd !== null ? (
            <span aria-hidden className="mr-2 text-accent">
              [x]
            </span>
          ) : (
            <span aria-hidden className="mr-2 text-muted">
              [ ]
            </span>
          )}
          {row.label}
          {!row.planned ? (
            <span className="ml-2 text-xs uppercase tracking-wide text-warning">
              unplanned
            </span>
          ) : null}
        </span>
        <span className="whitespace-nowrap text-sm">
          {row.paidUsd !== null ? (
            <>
              <Money usd={row.paidUsd} size="sm" />{" "}
              <span className="text-xs text-muted">
                {row.settlement === "x402" ? "paid via x402" : "paid"}
              </span>
            </>
          ) : row.estUsd !== null ? (
            <>
              <span className="text-xs text-muted">est</span>{" "}
              <Money usd={row.estUsd} size="sm" />
            </>
          ) : null}
        </span>
      </div>
      {row.note !== null ? (
        <p className="mt-1 pl-7 text-sm text-foreground/80">{row.note}</p>
      ) : null}
    </li>
  );
}

export default function AgentReceipt({ ledger }: { ledger: LedgerEntry[] }) {
  const receipt = projectReceipt(ledger);

  return (
    <div className="rounded-xl border border-edge bg-surface-raised p-4 font-mono">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted">
        SPOTTER receipt
      </p>
      <ol className="mt-3 space-y-3">
        {receipt.rows.map((row, index) => {
          switch (row.kind) {
            case "spend":
              return <SpendRow key={index} row={row} />;
            case "verdict":
              return (
                <li key={index} className="animate-rise-in pl-7">
                  <Verdict verified={row.verified} confidence={row.confidence} />
                  <p className="mt-1 text-sm text-foreground/80">
                    {row.escalation ? "second opinion: " : ""}
                    {row.reason}
                  </p>
                </li>
              );
            case "reason":
              return (
                <li key={index} className="animate-rise-in pl-7 text-sm">
                  <span className="text-xs uppercase tracking-wide text-muted">
                    decision
                  </span>{" "}
                  <span
                    className={
                      row.decision === "pay" ? "text-accent" : "text-warning"
                    }
                  >
                    {row.decision}
                  </span>
                  <p className="mt-1 text-foreground/80">{row.note}</p>
                </li>
              );
            case "record":
              return (
                <li key={index} className="animate-rise-in pl-7 text-sm">
                  <span className="text-xs uppercase tracking-wide text-muted">
                    recorded on-chain
                  </span>
                  {row.resultTx !== null ? (
                    <p className="mt-1">
                      <ArcTxLink txHash={row.resultTx} label="result tx" />
                    </p>
                  ) : null}
                  {row.registryTx !== null ? (
                    <p className="mt-1">
                      <ArcTxLink txHash={row.registryTx} label="verdict registry tx" />
                    </p>
                  ) : null}
                </li>
              );
            case "settle":
              return (
                <li key={index} className="animate-rise-in pl-7 text-sm">
                  {row.status === "settled" && row.paidUsd !== null ? (
                    <span>
                      settled: <Money usd={row.paidUsd} sign="+" size="sm" /> paid
                    </span>
                  ) : (
                    <span className="text-muted">
                      {row.note ?? "settlement pending"}
                    </span>
                  )}
                  {row.txHash !== null ? (
                    <p className="mt-1">
                      <ArcTxLink txHash={row.txHash} label="settle tx" />
                    </p>
                  ) : null}
                </li>
              );
            case "error":
              return (
                <li key={index} className="animate-rise-in pl-7 text-sm text-danger">
                  {row.stage}: {row.message}
                </li>
              );
          }
        })}
      </ol>
      {receipt.capUsd !== null ? (
        <p className="mt-4 border-t border-edge pt-3 text-sm">
          Spent <Money usd={receipt.spentUsd} size="sm" /> of a{" "}
          <Money usd={receipt.capUsd} size="sm" /> cap on this claim.
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted">
        Your document never left the secure enclave. SPOTTER only ever saw the
        verdict.
      </p>
    </div>
  );
}
