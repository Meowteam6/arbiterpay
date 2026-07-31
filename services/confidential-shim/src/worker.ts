// Single FIFO worker, concurrency 1. A 4B model on CPU saturates the box with
// one inference; running jobs serially keeps latency predictable and memory
// bounded. Document bytes are taken out of the store right before the run and
// garbage-collected right after.

import type { JobPayload, JobStore } from "./jobs.js";

export type InferenceRunner = (payload: JobPayload) => Promise<string>;

export class InferenceWorker {
  private readonly queue: string[] = [];
  private draining = false;
  /** Resolves whenever the queue empties; tests await this. */
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly store: JobStore,
    private readonly runner: InferenceRunner,
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
          this.store.complete(id, output);
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
