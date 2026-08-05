import fs from "node:fs";
import { FINDINGS_DIR, SHOTS_DIR } from "./walls";

/**
 * globalSetup: start each explorer run from a clean slate so the aggregated
 * findings.md only ever describes THIS run — stale findings from a previous
 * session would otherwise leak into the report.
 */
export default function reset(): void {
  for (const dir of [FINDINGS_DIR, SHOTS_DIR]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
}
