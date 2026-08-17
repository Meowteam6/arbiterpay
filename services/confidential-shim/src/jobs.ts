// Job store: in-memory Map for live state plus one small JSON journal file per
// job (id, status, timestamps, verdict text, error). The journal exists so a
// verdict already produced survives a process restart and so a restart can
// honestly mark interrupted jobs failed instead of leaving them queued forever.
//
// PRIVACY INVARIANT: document bytes live ONLY in the in-memory payload map and
// are dropped the moment the worker takes them. They are never written to the
// journal, never logged, and never included in any API response. Persisting
// only the verdict is the shim's version of the attester's core privacy claim.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type JobStatus = "queued" | "running" | "completed" | "failed";

const TERMINAL_STATUSES: readonly JobStatus[] = ["completed", "failed"];

export type SupportedContentType =
  | "image/png"
  | "image/jpeg"
  | "application/pdf"
  | "text/plain";

export interface JobResource {
  filename: string;
  contentType: SupportedContentType;
  bytes: Buffer;
}

/** The request payload the worker needs. In-memory only; never journaled. */
export interface JobPayload {
  systemPrompt: string;
  prompt: string;
  resources: JobResource[];
  /** The claim's on-chain goalId (0x + 64 hex). Non-sensitive routing scalar,
   *  folded into the verdict signature so a signature is not replayable across
   *  claims. Optional: a caller that does not bind a goal signs against zeros. */
  goalId?: string;
}

/** Journaled job metadata. This is the full set of persisted fields. */
export interface JobMeta {
  id: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  /** Model output on completion: the strict-JSON verdict text. */
  output?: string;
  error?: string;
  /** The claim's goalId, persisted for provenance. Non-sensitive. */
  goal_id?: string;
  /** JSON-stringified SignatureEnvelope over the completed verdict. */
  signature?: string;
}

const JOURNAL_FILE = /^[0-9a-f-]{36}\.json$/;

function isJobStatus(value: unknown): value is JobStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed"
  );
}

export class JobStore {
  private readonly meta = new Map<string, JobMeta>();
  private readonly payloads = new Map<string, JobPayload>();

  constructor(private readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.reloadJournal();
  }

  /**
   * Load journal files from a previous process. Terminal jobs keep their
   * verdict or error. Non-terminal (queued/running) jobs are marked failed:
   * their document bytes died with the old process, so pretending they are
   * still in flight would hang the app's poll loop forever. Fail closed and
   * let the participant resubmit.
   */
  private reloadJournal(): void {
    for (const entry of fs.readdirSync(this.dataDir)) {
      if (JOURNAL_FILE.test(entry) === false) continue;
      const filePath = path.join(this.dataDir, entry);
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record.id !== "string" || isJobStatus(record.status) === false) {
        continue;
      }
      const meta: JobMeta = {
        id: record.id,
        status: record.status,
        created_at:
          typeof record.created_at === "string"
            ? record.created_at
            : new Date().toISOString(),
        updated_at:
          typeof record.updated_at === "string"
            ? record.updated_at
            : new Date().toISOString(),
        ...(typeof record.output === "string" ? { output: record.output } : {}),
        ...(typeof record.error === "string" ? { error: record.error } : {}),
        ...(typeof record.goal_id === "string" ? { goal_id: record.goal_id } : {}),
        ...(typeof record.signature === "string"
          ? { signature: record.signature }
          : {}),
      };
      if (TERMINAL_STATUSES.includes(meta.status) === false) {
        meta.status = "failed";
        meta.error =
          "The shim restarted before this inference completed. Resubmit the document.";
        meta.updated_at = new Date().toISOString();
        this.writeJournal(meta);
      }
      this.meta.set(meta.id, meta);
    }
  }

  private journalPath(id: string): string {
    return path.join(this.dataDir, `${id}.json`);
  }

  private writeJournal(meta: JobMeta): void {
    fs.writeFileSync(this.journalPath(meta.id), JSON.stringify(meta, null, 2));
  }

  create(payload: JobPayload): JobMeta {
    const now = new Date().toISOString();
    const meta: JobMeta = {
      id: randomUUID(),
      status: "queued",
      created_at: now,
      updated_at: now,
      ...(payload.goalId !== undefined ? { goal_id: payload.goalId } : {}),
    };
    this.meta.set(meta.id, meta);
    this.payloads.set(meta.id, payload);
    this.writeJournal(meta);
    return meta;
  }

  get(id: string): JobMeta | undefined {
    return this.meta.get(id);
  }

  /**
   * Hand the payload (including document bytes) to the worker exactly once.
   * The store forgets the bytes immediately so nothing outside the single
   * in-flight inference ever holds them.
   */
  takePayload(id: string): JobPayload | undefined {
    const payload = this.payloads.get(id);
    this.payloads.delete(id);
    return payload;
  }

  markRunning(id: string): void {
    this.transition(id, { status: "running" });
  }

  complete(id: string, output: string, signature?: string): void {
    this.transition(id, { status: "completed", output, signature });
  }

  fail(id: string, error: string): void {
    this.payloads.delete(id);
    this.transition(id, { status: "failed", error });
  }

  private transition(
    id: string,
    change: {
      status: JobStatus;
      output?: string;
      error?: string;
      signature?: string;
    },
  ): void {
    const meta = this.meta.get(id);
    if (meta === undefined) return;
    meta.status = change.status;
    if (change.output !== undefined) meta.output = change.output;
    if (change.error !== undefined) meta.error = change.error;
    if (change.signature !== undefined) meta.signature = change.signature;
    meta.updated_at = new Date().toISOString();
    this.writeJournal(meta);
  }
}
