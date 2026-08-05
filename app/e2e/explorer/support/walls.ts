import fs from "node:fs";
import path from "node:path";
import { test as base, type Page, type TestInfo } from "@playwright/test";

/**
 * Wall detection for explorer personas.
 *
 * A "wall" is any moment a real user would stop making progress: a console
 * error, an uncaught page error, an HTTP >= 400, an error banner, a click
 * that changed nothing, or a step that never finished. Walls are RECORDED,
 * never thrown — the persona keeps going and the findings file is the
 * deliverable. Each wall carries a screenshot, a video-relative timestamp,
 * and a snapshot of the action log so far (= repro steps).
 */

export const ARTIFACT_ROOT = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "e2e-artifacts",
  "explorer",
);
export const FINDINGS_DIR = path.join(ARTIFACT_ROOT, "findings");
export const SHOTS_DIR = path.join(ARTIFACT_ROOT, "shots");

/** Routes where a failure touches money movement; tagged for severity. */
const MONEY_ROUTE_PREFIXES = ["/api/oracle", "/api/evidence", "/api/agent", "/api/pools"];

/** Runaway guard: a page erroring in a loop should not produce 500 walls. */
const MAX_WALLS = 40;

export type WallKind =
  | "console-error"
  | "page-error"
  | "http-error"
  | "network-failure"
  | "error-banner"
  | "no-op-click"
  | "stuck-state"
  | "cannot-proceed";

export interface Wall {
  kind: WallKind;
  detail: string;
  moneyRoute: boolean;
  url?: string;
  status?: number;
  screenshot?: string;
  videoTimestampMs: number;
  actionLog: string[];
  at: string;
}

export interface Findings {
  persona: string;
  intent: string;
  startedAt: string;
  finishedAt: string;
  video?: string;
  trace?: string;
  walls: Wall[];
  actionLog: string[];
}

function isMoneyRoute(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    return MONEY_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  } catch {
    return false;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

/** Visible-text patterns that read as an error/config banner to a user. */
const BANNER_PATTERNS =
  /not configured|unavailable in this build|something went wrong|failed to|could not|unable to|try again later|configuration/i;

/**
 * Console noise that belongs to the dev server, not the product. The
 * hot-module-reload websocket (`/_next/webpack-hmr`) and React DevTools hints
 * only exist under `next dev`; a real visitor on a production build never sees
 * them, so recording them as walls would be a detector artifact, not a
 * finding. Everything else the console emits is kept.
 */
const DEV_CONSOLE_NOISE =
  /webpack-hmr|_next\/static\/.*hot-update|react devtools|\[hmr\]|\[fast refresh\]/i;

export interface DomProbe {
  url: string;
  domHash: string;
}

export class Explorer {
  readonly page: Page;
  readonly testInfo: TestInfo;
  persona = "unnamed-persona";
  intent = "";
  private readonly startedAtMs: number;
  private readonly startedAtIso: string;
  private readonly actionLog: string[] = [];
  private readonly walls: Wall[] = [];
  private readonly seen = new Set<string>();
  private readonly pending: Promise<void>[] = [];
  private shotSeq = 0;
  private finalized: { path: string; wallCount: number } | null = null;

  constructor(page: Page, testInfo: TestInfo) {
    this.page = page;
    this.testInfo = testInfo;
    // The context (and therefore the video) starts recording moments before
    // the fixture arms; this is the closest zero we can get without probing
    // the recorder itself, and it is accurate to well under a second.
    this.startedAtMs = Date.now();
    this.startedAtIso = new Date(this.startedAtMs).toISOString();
  }

  setPersona(name: string, intent: string): void {
    this.persona = name;
    this.intent = intent;
  }

  /** Wire the passive listeners. Called once by the fixture. */
  arm(): void {
    this.page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      // Dev-server hot-reload chatter is not something a real user meets.
      if (DEV_CONSOLE_NOISE.test(text)) return;
      this.queueWall("console-error", text, { dedupeKey: `console:${text}` });
    });
    this.page.on("pageerror", (error) => {
      this.queueWall("page-error", error.message, { dedupeKey: `pageerror:${error.message}` });
    });
    this.page.on("response", (response) => {
      const status = response.status();
      if (status < 400) return;
      const url = response.url();
      let pathname = url;
      try {
        pathname = new URL(url).pathname;
      } catch {
        // keep the raw url
      }
      this.queueWall("http-error", `HTTP ${status} on ${pathname}`, {
        url,
        status,
        dedupeKey: `http:${status}:${pathname}`,
      });
    });
    this.page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "unknown failure";
      // Aborted requests are routine (navigation, React strict-mode); only
      // hard failures read as walls.
      if (failure.includes("ERR_ABORTED") || failure.includes("cancelled")) return;
      // The hot-reload channel is dev-server infrastructure, not the product.
      if (DEV_CONSOLE_NOISE.test(request.url())) return;
      let pathname = request.url();
      try {
        pathname = new URL(request.url()).pathname;
      } catch {
        // keep the raw url
      }
      this.queueWall("network-failure", `${failure} on ${pathname}`, {
        url: request.url(),
        dedupeKey: `reqfail:${failure}:${pathname}`,
      });
    });
  }

  log(entry: string): void {
    const stamp = this.formatTimestamp(Date.now() - this.startedAtMs);
    this.actionLog.push(`[${stamp}] ${entry}`);
  }

  getActionLog(): readonly string[] {
    return this.actionLog;
  }

  getWalls(): readonly Wall[] {
    return this.walls;
  }

  /** Fire-and-collect wrapper so sync event handlers can record walls. */
  private queueWall(
    kind: WallKind,
    detail: string,
    opts: { url?: string; status?: number; dedupeKey?: string } = {},
  ): void {
    this.pending.push(
      this.recordWall(kind, detail, opts).catch(() => {
        // A wall recorder that throws must never take the persona down.
      }),
    );
  }

  /**
   * Record a wall: screenshot, video-relative timestamp, action-log snapshot.
   * Never throws, never fails the run.
   */
  async recordWall(
    kind: WallKind,
    detail: string,
    opts: { url?: string; status?: number; dedupeKey?: string } = {},
  ): Promise<void> {
    if (opts.dedupeKey !== undefined) {
      if (this.seen.has(opts.dedupeKey)) return;
      this.seen.add(opts.dedupeKey);
    }
    if (this.walls.length >= MAX_WALLS) return;

    const videoTimestampMs = Date.now() - this.startedAtMs;
    let screenshot: string | undefined;
    try {
      this.shotSeq += 1;
      const fileName = `${slug(this.persona)}-${String(this.shotSeq).padStart(2, "0")}-${slug(kind)}.png`;
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      const shotPath = path.join(SHOTS_DIR, fileName);
      await this.page.screenshot({ path: shotPath, timeout: 5_000 });
      screenshot = shotPath;
    } catch {
      // A crashed page cannot be photographed; the wall still counts.
    }

    const wall: Wall = {
      kind,
      detail: detail.slice(0, 2_000),
      moneyRoute: opts.url !== undefined ? isMoneyRoute(opts.url) : false,
      url: opts.url,
      status: opts.status,
      screenshot,
      videoTimestampMs,
      actionLog: [...this.actionLog],
      at: new Date().toISOString(),
    };
    this.walls.push(wall);
    this.log(
      `WALL(${kind}): ${detail.slice(0, 200)}${wall.moneyRoute ? " [MONEY ROUTE]" : ""}`,
    );
  }

  /**
   * Sweep the current page for error banners / cannot-proceed text a user
   * would see. Call after meaningful steps; dedupes by banner text.
   */
  async checkErrorBanners(): Promise<void> {
    try {
      const texts = await this.page.evaluate((patternSource: string) => {
        const pattern = new RegExp(patternSource, "i");
        const found: string[] = [];
        const candidates = document.querySelectorAll(
          "[role='alert'], [aria-live='assertive'], p, div, span",
        );
        for (const el of Array.from(candidates)) {
          if (found.length >= 10) break;
          const node = el as HTMLElement;
          if (node.offsetParent === null && node.getAttribute("role") !== "alert") continue;
          // Leaf-ish nodes only, so we report the banner, not the page.
          if (node.children.length > 3) continue;
          const text = (node.innerText ?? "").trim();
          if (text.length === 0 || text.length > 300) continue;
          const isAlert = node.getAttribute("role") === "alert";
          if (isAlert || pattern.test(text)) found.push(text);
        }
        return found;
      }, BANNER_PATTERNS.source);
      for (const text of texts) {
        await this.recordWall("error-banner", text, { dedupeKey: `banner:${text}` });
      }
    } catch {
      // Page navigated mid-sweep; nothing to record.
    }
  }

  /** Cheap DOM fingerprint for no-op click detection. */
  async probeDom(): Promise<DomProbe> {
    try {
      const domHash = await this.page.evaluate(() => {
        const body = document.body?.innerHTML ?? "";
        let hash = 0;
        for (let i = 0; i < body.length; i += 1) {
          hash = (hash * 31 + body.charCodeAt(i)) | 0;
        }
        return `${body.length}:${hash}`;
      });
      return { url: this.page.url(), domHash };
    } catch {
      return { url: this.page.url(), domHash: "unreadable" };
    }
  }

  formatTimestamp(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  /**
   * Flush pending wall recordings and write the findings JSON. Idempotent:
   * the fixture calls it in teardown as a backstop, personas call it as
   * their one hard assertion.
   */
  async finalize(): Promise<{ path: string; wallCount: number }> {
    if (this.finalized !== null) return this.finalized;
    await Promise.allSettled(this.pending);
    await this.checkErrorBanners();
    await Promise.allSettled(this.pending);

    let video: string | undefined;
    try {
      video = await this.page.video()?.path();
    } catch {
      video = undefined;
    }

    const findings: Findings = {
      persona: this.persona,
      intent: this.intent,
      startedAt: this.startedAtIso,
      finishedAt: new Date().toISOString(),
      video,
      walls: this.walls,
      actionLog: this.actionLog,
    };

    fs.mkdirSync(FINDINGS_DIR, { recursive: true });
    const filePath = path.join(FINDINGS_DIR, `${slug(this.persona)}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(findings, null, 2)}\n`, "utf8");
    await this.testInfo.attach(`findings-${this.persona}`, {
      path: filePath,
      contentType: "application/json",
    });

    this.finalized = { path: filePath, wallCount: this.walls.length };
    return this.finalized;
  }
}

export interface ExplorerFixtures {
  explorer: Explorer;
}

export const test = base.extend<ExplorerFixtures>({
  explorer: async ({ page }, use, testInfo) => {
    const explorer = new Explorer(page, testInfo);
    explorer.arm();
    await use(explorer);
    // Backstop: if the persona crashed before its own finalize, the walls
    // gathered so far still land on disk.
    await explorer.finalize();
  },
});

export { expect } from "@playwright/test";
