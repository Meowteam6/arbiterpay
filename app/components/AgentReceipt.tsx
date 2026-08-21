"use client";

// The most protected surface in the build: SPOTTER's per-claim receipt.
// Every row maps one-to-one onto a ledger entry via projectReceipt - planned
// steps print before their prices, the escalation prints unplanned at its
// chronological position, and the running total stands against the frozen
// cap. Nothing renders here that did not go through the ledger first.
//
// Two display rules on top of the projection: repeated errors of the same
// stage and message collapse into one row with a count (the ledger is
// append-only, so retries accumulate rows), and error rows lead with a calm
// plain-language label - the raw message stays available behind a disclosure,
// never as a wall of red.

import {
  projectReceipt,
  type LedgerEntry,
  type ReceiptRow,
} from "@/lib/agent-receipt";
import { ArcTxLink, Money, Verdict } from "@/components/ui";

type SpendReceiptRow = Extract<ReceiptRow, { kind: "spend" }>;

// settle.periodEndIso is an optional field newer ledgers carry on deferred
// entries; widened locally so this file compiles whether or not the ledger
// type has it yet.
type SettleLedgerEntry = Extract<LedgerEntry, { kind: "settle" }> & {
  periodEndIso?: string;
};

const GATEWAY_NOTE = /gateway tx (\S+)/;

// The non-component helpers below are exported for the unit tests in
// AgentReceipt.test.ts; nothing else imports them.

export function gatewayRefOf(note: string | null): string | null {
  if (note === null) return null;
  return GATEWAY_NOTE.exec(note)?.[1] ?? null;
}

export function noteWithoutGatewayRef(note: string | null): string | null {
  if (note === null) return null;
  const rest = note.replace(GATEWAY_NOTE, "").replace(/\s{2,}/g, " ").trim();
  return rest === "" ? null : rest;
}

function shortRef(ref: string): string {
  return ref.length > 16 ? `${ref.slice(0, 10)}…${ref.slice(-4)}` : ref;
}

/** Local, human moment for a settle time; null when unparseable. Same-day
 *  moments render as a time, anything else as date plus time. */
export function formatSettleMoment(date: Date): string | null {
  if (Number.isNaN(date.getTime())) return null;
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

const EPOCH_NOTE = /pool period ends at (\d+)/;

/** The line a deferred settle moment renders as; null when the date is
 *  invalid. Future moments read as a promise; past moments must not - the
 *  pool period already ended, so the honest copy is that SPOTTER settles on
 *  its next pass. */
export function settleMomentLine(date: Date): string | null {
  const when = formatSettleMoment(date);
  if (when === null) return null;
  return date.getTime() > Date.now()
    ? `SPOTTER settles this automatically at ${when}`
    : `the pool period ended at ${when}; SPOTTER settles this on its next pass`;
}

/** What a deferred settle row says. Prefers the entry's periodEndIso, then a
 *  recognizable epoch inside the prose note - converted, never shown raw -
 *  then the note itself. */
export function deferredSettleCopy(
  periodEndIso: string | undefined,
  note: string | null,
): string {
  // typeof guard, not an undefined check: the field is untyped in old
  // ledgers, and a runtime null would otherwise become new Date(null),
  // which is VALID and renders Jan 1 1970 as the settle time.
  if (typeof periodEndIso === "string") {
    const line = settleMomentLine(new Date(periodEndIso));
    if (line !== null) return line;
  }
  const epoch = note !== null ? EPOCH_NOTE.exec(note) : null;
  if (epoch !== null) {
    const seconds = Number(epoch[1]);
    const line =
      seconds > 1e9 && seconds < 1e11
        ? settleMomentLine(new Date(seconds * 1000))
        : null;
    return (
      line ??
      "SPOTTER settles this automatically the moment the pool period ends"
    );
  }
  return note ?? "settlement pending";
}

/** Calm per-stage label for an error row. Transient conditions (the chain not
 *  ready yet, the verification service briefly down) read as waiting, not as
 *  failure; only genuine failures keep the danger tone. */
export function errorPresentation(
  stage: string,
  message: string,
): { label: string; transient: boolean } {
  switch (stage) {
    case "attester":
      return { label: "verification service unreachable", transient: true };
    case "buy":
      // The AFTER-settlement case is not a clean stop: money already moved
      // for a purchase that then broke the cap. Say so in the headline.
      if (message.includes("AFTER settlement")) {
        return {
          label: "a purchase cost more than estimated after it was paid",
          transient: false,
        };
      }
      return message.includes("cap")
        ? { label: "stopped at the spend cap for this claim", transient: false }
        : {
            label: "could not buy the verification this claim needs",
            transient: false,
          };
    case "record":
      return {
        label: "could not record the verdict on-chain",
        transient: false,
      };
    case "settle":
      if (message.includes("canSettle")) {
        return { label: "settlement is waiting on the chain", transient: true };
      }
      if (message.includes("pool settled before this claim completed")) {
        return {
          label: "the pool settled before this claim finished",
          transient: false,
        };
      }
      return { label: "settlement did not complete", transient: false };
    default:
      return { label: "this step did not complete", transient: false };
  }
}

type DisplayItem =
  | { kind: "row"; key: number; row: Exclude<ReceiptRow, { kind: "error" }> }
  | {
      kind: "errors";
      key: number;
      stage: string;
      message: string;
      count: number;
    };

/** Collapse consecutive error rows with the same stage and message into one
 *  item with a count; every other row passes through untouched. */
export function collapseErrors(rows: ReceiptRow[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  rows.forEach((row, index) => {
    if (row.kind === "error") {
      const last = items[items.length - 1];
      if (
        last !== undefined &&
        last.kind === "errors" &&
        last.stage === row.stage &&
        last.message === row.message
      ) {
        last.count += 1;
        return;
      }
      items.push({
        kind: "errors",
        key: index,
        stage: row.stage,
        message: row.message,
        count: 1,
      });
      return;
    }
    items.push({ kind: "row", key: index, row });
  });
  return items;
}

function SpendRow({ row }: { row: SpendReceiptRow }) {
  const gatewayRef = gatewayRefOf(row.note);
  const note = noteWithoutGatewayRef(row.note);
  return (
    <li className="animate-rise-in">
      {/* Both columns must be able to shrink at 375px. The left label carries
          strings as long as "chain verification read (QuickNode, x402)" and
          needs min-w-0 or it refuses to wrap and pushes the row wider than the
          card; the right column must not be whitespace-nowrap for the same
          reason. Only the amount itself stays unbreakable - a money figure
          split across two lines is worse than a wrap anywhere else. */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 break-words text-sm font-medium">
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
        <span className="min-w-0 text-right text-sm">
          {row.paidUsd !== null ? (
            <>
              <span className="whitespace-nowrap">
                <Money usd={row.paidUsd} size="sm" />
              </span>{" "}
              {row.settlement === "x402" ? (
                <span className="whitespace-nowrap text-xs text-muted">
                  paid via x402
                </span>
              ) : row.settlement === "prepaid" ? (
                <span className="text-xs text-muted">metered</span>
              ) : null}
            </>
          ) : row.estUsd !== null ? (
            <span className="whitespace-nowrap">
              <span className="text-xs text-muted">est</span>{" "}
              <Money usd={row.estUsd} size="sm" />
            </span>
          ) : null}
        </span>
      </div>
      {/* The gateway reference gets its own line rather than trailing the
          amount: a 15-character mono ref cannot fit beside a price inside a
          311px content box, and it is a proof link, not a price. */}
      {gatewayRef !== null ? (
        <p className="mt-1 pl-7 text-xs text-muted">
          gateway tx{" "}
          <span className="break-all font-mono" title={gatewayRef}>
            {shortRef(gatewayRef)}
          </span>
        </p>
      ) : null}
      {note !== null ? (
        <p className="mt-1 break-words pl-7 text-sm text-foreground/80">
          {note}
        </p>
      ) : null}
    </li>
  );
}

function ErrorRow({
  stage,
  message,
  count,
}: {
  stage: string;
  message: string;
  count: number;
}) {
  const { label, transient } = errorPresentation(stage, message);
  return (
    <li className="animate-rise-in pl-7 text-sm">
      <details>
        {/* min-h-11 keeps the disclosure a real 44px thumb target; the flex
            wrap lets the label and the "details" affordance stack at 375px
            instead of forcing the row wider than the card. */}
        <summary
          className={`flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 [&::-webkit-details-marker]:hidden ${
            transient ? "text-muted" : "text-danger"
          }`}
        >
          <span className="min-w-0 break-words">{label}</span>
          {count > 1 ? (
            <span className="text-xs text-muted">tried {count} times</span>
          ) : null}
          <span className="text-xs text-muted underline decoration-dotted">
            details
          </span>
        </summary>
        <p className="mt-1 break-words text-xs text-muted">
          {stage}: {message}
        </p>
      </details>
    </li>
  );
}

export default function AgentReceipt({
  ledger,
  evidenceKind = "document",
}: {
  ledger: LedgerEntry[];
  /** Which evidence path this receipt belongs to. Defaults to "document" so
   *  every existing caller is unchanged; the wearable path opts in so the
   *  privacy footer tells the truth. Only the document/self-reported paths run
   *  inside the confidential enclave (lib/server/judge.ts); the wearable path
   *  reads the Junction summary on SPOTTER's own server, so it must not claim
   *  otherwise. The self-reported path is the same enclave read but the footer
   *  states plainly that the proof is low-trust and unverified. */
  evidenceKind?: "document" | "wearable" | "self-reported";
}) {
  const receipt = projectReceipt(ledger);
  const items = collapseErrors(receipt.rows);
  const deferredEntry = ledger.find(
    (e) => e.kind === "settle" && e.status === "deferred",
  ) as SettleLedgerEntry | undefined;

  return (
    <div className="rounded-xl border border-edge bg-surface-raised p-4 font-mono">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted">
        SPOTTER receipt
      </p>
      <ol className="mt-3 space-y-3">
        {items.map((item) => {
          if (item.kind === "errors") {
            return (
              <ErrorRow
                key={item.key}
                stage={item.stage}
                message={item.message}
                count={item.count}
              />
            );
          }
          const row = item.row;
          switch (row.kind) {
            case "spend":
              return <SpendRow key={item.key} row={row} />;
            case "verdict":
              return (
                <li key={item.key} className="animate-rise-in pl-7">
                  <Verdict
                    verified={row.verified}
                    confidence={row.confidence}
                    selfReported={row.selfReported}
                  />
                  <p className="mt-1 text-sm text-foreground/80">
                    {row.escalation ? "second opinion: " : ""}
                    {row.reason}
                  </p>
                </li>
              );
            case "reason":
              return (
                <li key={item.key} className="animate-rise-in pl-7 text-sm">
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
                <li key={item.key} className="animate-rise-in pl-7 text-sm">
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
                      <ArcTxLink
                        txHash={row.registryTx}
                        label="verdict registry tx"
                      />
                    </p>
                  ) : null}
                </li>
              );
            case "settle":
              return (
                <li key={item.key} className="animate-rise-in pl-7 text-sm">
                  {row.status === "settled" && row.paidUsd !== null ? (
                    <span>
                      settled: <Money usd={row.paidUsd} sign="+" size="sm" />{" "}
                      paid
                    </span>
                  ) : row.status === "deferred" ? (
                    <span className="text-muted">
                      {deferredSettleCopy(
                        deferredEntry?.periodEndIso,
                        row.note,
                      )}
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
        {evidenceKind === "wearable"
          ? "Your wearable data stayed server-side and was never written on-chain. Only the verdict was recorded."
          : evidenceKind === "self-reported"
            ? "Your photo went to the enclave only for the read and was never stored. Self-reported proof is low-trust and still in development: we cannot confirm it is real, recent, or yours, so it is never marked verified."
            : "Your document never left the secure enclave. SPOTTER only ever saw the verdict."}
      </p>
    </div>
  );
}
