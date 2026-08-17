// Single FIFO worker, concurrency 1. A 4B model on CPU saturates the box with
// one inference; running jobs serially keeps latency predictable and memory
// bounded. Document bytes are taken out of the store right before the run and
// garbage-collected right after.

import type { Hex } from "viem";
import type { JobPayload, JobStore } from "./jobs.js";
import { parseVerdictScalars } from "./ollama.js";
import type { VerdictSigner } from "./signing.js";

export type InferenceRunner = (payload: JobPayload) => Promise<string>;

const ZERO_GOAL: Hex = `0x${"00".repeat(32)}`;

export class InferenceWorker {
  private readonly queue: string[] = [];
  private draining = false;
  /** Resolves whenever the queue empties; tests await this. */
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly store: JobStore,
    private readonly runner: InferenceRunner,
    /** When present, every completed verdict is signed in the enclave. */
    private readonly signer?: VerdictSigner,
  ) {}

  enqueue(id: string): void {
    this.queue.push(id);
    void this.drain();
  }

  /** Await until the worker has no queued or running job. */
  async idle(): Promise<void> {
    if (this.draining === false && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift();
        if (id === undefined) break;
        const payload = this.store.takePayload(id);
        if (payload === undefined) {
          this.store.fail(id, "internal: job payload missing");
          continue;
        }
        this.store.markRunning(id);
        try {
          const output = await this.runner(payload);
          let signature: string | undefined;
          if (this.signer !== undefined) {
            const scalars = parseVerdictScalars(output);
            const goalId = (payload.goalId as Hex | undefined) ?? ZERO_GOAL;
            const env = await this.signer.signVerdict(
              goalId,
              scalars.verified,
              scalars.confidence,
              output,
            );
            signature = JSON.stringify(env);
          }
          this.store.complete(id, output, signature);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[shim] inference ${id} failed: ${message}`);
          this.store.fail(id, message);
        }
      }
    } finally {
      this.draining = false;
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }
}
