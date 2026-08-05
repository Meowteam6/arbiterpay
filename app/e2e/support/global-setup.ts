import { rm } from "fs/promises";
import path from "path";

/**
 * Start every run from an empty agent ledger.
 *
 * The file store under DATA_DIR is append-only and indexed, so a ledger left
 * behind by an earlier run would show up in /api/agent/feed and make the
 * receipts spec pass or fail on history rather than on what this run did.
 */
export default async function globalSetup(): Promise<void> {
  await rm(path.join(__dirname, "..", "..", ".data-e2e"), {
    recursive: true,
    force: true,
  });
}
