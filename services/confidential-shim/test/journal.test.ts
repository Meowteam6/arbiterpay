// Journal semantics across a process restart. The bytes of a queued or running
// job die with the process, so a restarted shim must mark those jobs failed
// (the app then resolves them to an unverified verdict and the participant
// resubmits). Completed and failed jobs keep their verdict or error.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobStore, type JobPayload } from "../src/jobs.js";

const VERDICT =
  '{"verified": true, "confidence": "high", "reason": "flu shot present"}';

function payload(): JobPayload {
  return {
    systemPrompt: "judge strictly",
    prompt: "did this person get a flu shot",
    resources: [
      {
        filename: "flu.txt",
        contentType: "text/plain",
        bytes: Buffer.from("flu shot administered 2026-01-10"),
      },
    ],
  };
}

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-journal-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("journal reload after restart", () => {
  it("marks queued and running jobs failed; keeps terminal jobs intact", () => {
    const before = new JobStore(dataDir);
    const queued = before.create(payload());
    const running = before.create(payload());
    before.takePayload(running.id);
    before.markRunning(running.id);
    const completed = before.create(payload());
    before.takePayload(completed.id);
    before.markRunning(completed.id);
    before.complete(completed.id, VERDICT);
    const failed = before.create(payload());
    before.fail(failed.id, "model server returned HTTP 500");

    // Simulate a restart: a fresh store over the same journal directory.
    const after = new JobStore(dataDir);

    expect(after.get(queued.id)?.status).toBe("failed");
    expect(after.get(queued.id)?.error).toMatch(/restarted/);
    expect(after.get(running.id)?.status).toBe("failed");
    expect(after.get(running.id)?.error).toMatch(/restarted/);

    expect(after.get(completed.id)?.status).toBe("completed");
    expect(after.get(completed.id)?.output).toBe(VERDICT);
    expect(after.get(failed.id)?.status).toBe("failed");
    expect(after.get(failed.id)?.error).toBe("model server returned HTTP 500");
  });

  it("rewrites the on-disk journal for interrupted jobs", () => {
    const before = new JobStore(dataDir);
    const queued = before.create(payload());

    new JobStore(dataDir);

    const journal = JSON.parse(
      fs.readFileSync(path.join(dataDir, `${queued.id}.json`), "utf8"),
    ) as { status: string; error?: string };
    expect(journal.status).toBe("failed");
    expect(journal.error).toMatch(/restarted/);
  });

  it("payloads do not survive a restart and never touch the journal", () => {
    const before = new JobStore(dataDir);
    const job = before.create(payload());

    const journalText = fs.readFileSync(
      path.join(dataDir, `${job.id}.json`),
      "utf8",
    );
    expect(journalText).not.toContain("flu shot administered");
    expect(journalText).not.toContain(
      Buffer.from("flu shot administered 2026-01-10").toString("base64"),
    );

    const after = new JobStore(dataDir);
    expect(after.takePayload(job.id)).toBeUndefined();
  });

  it("keeps a completed verdict's signature and goal_id across a restart", () => {
    const before = new JobStore(dataDir);
    const goalId = `0x${"ab".repeat(32)}`;
    const job = before.create({ ...payload(), goalId });
    before.takePayload(job.id);
    before.markRunning(job.id);
    const signature = JSON.stringify({ alg: "secp256k1-eth", v: 2, sig: "0xdead" });
    before.complete(job.id, VERDICT, signature);

    const after = new JobStore(dataDir);
    const reloaded = after.get(job.id);
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.output).toBe(VERDICT);
    expect(reloaded?.signature).toBe(signature);
    expect(reloaded?.goal_id).toBe(goalId);
    // document bytes still never touch the journal
    const raw = fs.readFileSync(path.join(dataDir, `${job.id}.json`), "utf8");
    expect(raw).not.toContain("flu shot administered");
  });

  it("ignores corrupt and foreign files in the journal directory", () => {
    const before = new JobStore(dataDir);
    const job = before.create(payload());
    before.takePayload(job.id);
    before.markRunning(job.id);
    before.complete(job.id, VERDICT);

    fs.writeFileSync(path.join(dataDir, "not-a-job.txt"), "junk");
    fs.writeFileSync(
      path.join(dataDir, "11111111-2222-3333-4444-555555555555.json"),
      "{corrupt",
    );

    const after = new JobStore(dataDir);
    expect(after.get(job.id)?.status).toBe("completed");
    expect(after.get("11111111-2222-3333-4444-555555555555")).toBeUndefined();
  });
});
