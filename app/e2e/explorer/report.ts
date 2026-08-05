import fs from "node:fs";
import path from "node:path";
import {
  ARTIFACT_ROOT,
  FINDINGS_DIR,
  type Findings,
  type Wall,
} from "./support/walls";

/**
 * Findings aggregator.
 *
 * Reads every per-persona findings JSON written by the walls fixture and
 * renders e2e-artifacts/explorer/findings.md: per wall — persona, user
 * intent, the money shot (screenshot + video + video-relative timestamp),
 * repro steps from the action log, a severity guess, and a ready-to-paste
 * /queue line.
 *
 * Runs as the Playwright globalTeardown, and standalone:
 *   npx tsx e2e/explorer/report.ts
 */

const REPORT_PATH = path.join(ARTIFACT_ROOT, "findings.md");

type Severity = "high" | "medium" | "low";

/**
 * Severity is a triage GUESS, not a verdict: money-route failures and
 * cannot-proceed states rank highest because they block or misreport money;
 * cosmetic console noise ranks lowest.
 */
function guessSeverity(wall: Wall): Severity {
  if (wall.moneyRoute && (wall.status ?? 0) >= 500) return "high";
  if (wall.kind === "stuck-state") return "high";
  if (wall.moneyRoute) return "medium";
  if (wall.kind === "http-error" && (wall.status ?? 0) >= 500) return "high";
  if (wall.kind === "page-error" || wall.kind === "cannot-proceed") return "medium";
  if (wall.kind === "no-op-click" || wall.kind === "error-banner") return "medium";
  if (wall.kind === "network-failure") return "medium";
  return "low";
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function relToArtifacts(filePath: string | undefined): string {
  if (filePath === undefined) return "(not captured)";
  return path.relative(ARTIFACT_ROOT, filePath);
}

function queueLine(finding: Findings, wall: Wall, severity: Severity): string {
  const where = wall.url !== undefined ? ` at ${wall.url}` : "";
  const summary = wall.detail.replace(/"/g, "'").slice(0, 120);
  return (
    `/queue repo:arbiterpay "[explorer/${finding.persona}] ${wall.kind}${where}: ` +
    `${summary}" — severity:${severity}` +
    `${wall.moneyRoute ? " label:money-route" : ""}`
  );
}

function renderWall(finding: Findings, wall: Wall, index: number): string {
  const severity = guessSeverity(wall);
  const lines: string[] = [];
  lines.push(`### ${finding.persona} — wall ${index + 1}: ${wall.kind}`);
  lines.push("");
  lines.push(`- **Persona / user intent:** ${finding.intent}`);
  lines.push(`- **What hit:** ${wall.detail}`);
  if (wall.url !== undefined) {
    lines.push(
      `- **Request:** \`${wall.url}\`${wall.status !== undefined ? ` → HTTP ${wall.status}` : ""}` +
        `${wall.moneyRoute ? " **(money route)**" : ""}`,
    );
  }
  lines.push(`- **Severity guess:** ${severity}`);
  lines.push("- **Money shot:**");
  lines.push(`  - screenshot: \`${relToArtifacts(wall.screenshot)}\``);
  lines.push(
    `  - video: \`${relToArtifacts(finding.video)}\` @ **${formatTimestamp(wall.videoTimestampMs)}**`,
  );
  lines.push("");
  lines.push("<details><summary>Repro steps (action log up to the wall)</summary>");
  lines.push("");
  wall.actionLog.forEach((step, stepIndex) => {
    lines.push(`${stepIndex + 1}. ${step}`);
  });
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push("```");
  lines.push(queueLine(finding, wall, severity));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

export function generateReport(): string {
  const files = fs.existsSync(FINDINGS_DIR)
    ? fs.readdirSync(FINDINGS_DIR).filter((name) => name.endsWith(".json")).sort()
    : [];

  const findings: Findings[] = files.map((name) => {
    const raw = fs.readFileSync(path.join(FINDINGS_DIR, name), "utf8");
    return JSON.parse(raw) as Findings;
  });

  const totalWalls = findings.reduce((sum, f) => sum + f.walls.length, 0);
  const lines: string[] = [];
  lines.push("# Explorer QA findings");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    `Personas run: ${findings.length} · Walls recorded: ${totalWalls}. ` +
      "Walls on an unconfigured surface (sign-in gates, config banners, refused " +
      "money routes) are legitimate findings of what a real visitor sees — " +
      "they are the deliverable, not test failures.",
  );
  lines.push("");
  lines.push("| Persona | Walls | Video |");
  lines.push("|---|---|---|");
  for (const finding of findings) {
    lines.push(
      `| ${finding.persona} | ${finding.walls.length} | \`${relToArtifacts(finding.video)}\` |`,
    );
  }
  lines.push("");

  for (const finding of findings) {
    lines.push(`## ${finding.persona}`);
    lines.push("");
    lines.push(`**Intent:** ${finding.intent}`);
    lines.push("");
    if (finding.walls.length === 0) {
      lines.push("No walls hit — the goal was reachable on this surface.");
      lines.push("");
    }
    finding.walls.forEach((wall, index) => {
      lines.push(renderWall(finding, wall, index));
    });
  }

  fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${lines.join("\n")}\n`, "utf8");
  return REPORT_PATH;
}

/** Playwright globalTeardown entry point. */
export default function globalTeardown(): void {
  const reportPath = generateReport();
  // eslint-disable-next-line no-console
  console.log(`\nExplorer findings report: ${reportPath}`);
}

// Standalone: `npx tsx e2e/explorer/report.ts`
if (process.argv[1] !== undefined && process.argv[1].endsWith("report.ts")) {
  globalTeardown();
}
