import type { Locator } from "@playwright/test";
import type { Explorer } from "./walls";

/**
 * Attempt-style DSL for explorer personas.
 *
 * Every step is a TRY: on success it advances the goal, on failure it notes
 * the wall and the persona continues with its next fallback. Nothing here
 * throws past the step boundary, and every step appends to the action log —
 * which is exactly the repro-steps list a wall report needs.
 */

const DEFAULT_STEP_TIMEOUT_MS = 20_000;
const DEFAULT_CLICK_GRACE_MS = 1_500;

export interface AttemptOptions {
  /** Budget before the step is recorded as a stuck-state wall. */
  timeoutMs?: number;
}

export interface ClickOptions extends AttemptOptions {
  /** When true (default), a click changing neither URL nor DOM is a wall. */
  expectChange?: boolean;
  /** How long the page gets to visibly react before the no-op verdict. */
  graceMs?: number;
}

export class Persona {
  private readonly ex: Explorer;

  constructor(explorer: Explorer, name: string, intent: string) {
    this.ex = explorer;
    this.ex.setPersona(name, intent);
    this.ex.log(`PERSONA ${name}: ${intent}`);
  }

  /** Free-form observation; lands in the action log verbatim. */
  note(message: string): void {
    this.ex.log(`NOTE: ${message}`);
  }

  /**
   * Run an arbitrary step under a timeout. Returns true on success; on
   * failure or timeout records a wall and returns false — never throws.
   */
  async attempt(
    label: string,
    fn: () => Promise<void>,
    opts: AttemptOptions = {},
  ): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.ex.log(`TRY: ${label}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`stuck for ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
      this.ex.log(`OK: ${label}`);
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stuck = message.startsWith("stuck for");
      await this.ex.recordWall(
        stuck ? "stuck-state" : "cannot-proceed",
        `${label} — ${message.split("\n")[0]}`,
      );
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Navigate; a failed or refused navigation is a wall, not a crash. */
  async tryGoto(pathname: string, why: string, opts: AttemptOptions = {}): Promise<boolean> {
    const ok = await this.attempt(`go to ${pathname} (${why})`, async () => {
      await this.ex.page.goto(pathname, { waitUntil: "domcontentloaded" });
    }, opts);
    await this.ex.checkErrorBanners();
    return ok;
  }

  /**
   * Click with no-op detection: fingerprint URL + DOM before, click, give
   * the page a grace window, fingerprint again. No change on either axis
   * records a no-op-click wall.
   */
  async tryClick(desc: string, locator: Locator, opts: ClickOptions = {}): Promise<boolean> {
    const expectChange = opts.expectChange ?? true;
    const graceMs = opts.graceMs ?? DEFAULT_CLICK_GRACE_MS;
    const before = expectChange ? await this.ex.probeDom() : null;

    const clicked = await this.attempt(`click ${desc}`, async () => {
      await locator.first().click({ timeout: opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS });
    }, opts);
    if (!clicked) return false;

    if (before !== null) {
      await this.ex.page.waitForTimeout(graceMs);
      const after = await this.ex.probeDom();
      if (after.url === before.url && after.domHash === before.domHash) {
        await this.ex.recordWall(
          "no-op-click",
          `clicking ${desc} changed neither the URL nor the DOM within ${graceMs}ms`,
        );
      }
    }
    await this.ex.checkErrorBanners();
    return true;
  }

  /** Fill a field; a missing or unfillable field is a wall. */
  async tryFill(
    desc: string,
    locator: Locator,
    value: string,
    opts: AttemptOptions = {},
  ): Promise<boolean> {
    return this.attempt(`fill ${desc} with "${value}"`, async () => {
      await locator.first().fill(value, { timeout: opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS });
    }, opts);
  }

  /**
   * Look for something the persona expects to see. Absence is recorded as a
   * cannot-proceed wall but, as with everything here, the run continues.
   */
  async trySee(desc: string, locator: Locator, opts: AttemptOptions = {}): Promise<boolean> {
    return this.attempt(`see ${desc}`, async () => {
      await locator.first().waitFor({
        state: "visible",
        timeout: opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      });
    }, opts);
  }

  /** Give the page time to settle, then sweep for banners. */
  async settle(ms = 1_500): Promise<void> {
    await this.ex.page.waitForTimeout(ms);
    await this.ex.checkErrorBanners();
  }
}
