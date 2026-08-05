import { rm } from "fs/promises";
import path from "path";
import { APP_BASE_URL } from "./protocol";

/** Every page the specs navigate to, one per dev-server route pattern. */
const WARMED_ROUTES = ["/", "/goal", "/pools", "/pools/1", "/agent"];

/**
 * Start every run from an empty agent ledger.
 *
 * The file store under DATA_DIR is append-only and indexed, so a ledger left
 * behind by an earlier run would show up in /api/agent/feed and make the
 * receipts spec pass or fail on history rather than on what this run did.
 *
 * Then warm the dev server's routes. Playwright boots the web servers before
 * global setup runs, and `next dev` compiles each route on first visit, so
 * one throwaway fetch per page moves that compile out of the first test that
 * lands on it. The main suite gets it back as a faster first test; the demo
 * profile gets it back as recordings that open on painted UI instead of
 * holding a blank frame while Turbopack compiles. Loopback only, and best
 * effort: a warm miss costs a slower first paint, never the run.
 */
export default async function globalSetup(): Promise<void> {
  await rm(path.join(__dirname, "..", "..", ".data-e2e"), {
    recursive: true,
    force: true,
  });

  await Promise.all(
    WARMED_ROUTES.map(async (route) => {
      try {
        await fetch(`${APP_BASE_URL}${route}`);
      } catch {
        // Reachability is the webServer block's job, not this one's.
      }
    }),
  );
}
