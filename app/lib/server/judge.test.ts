import { describe, it, expect, afterEach, vi } from "vitest";
import {
  submitInference,
  pollInference,
  isMockId,
  isFailId,
  type SupportedContentType,
} from "@/lib/server/judge";

// These tests pin the fail-closed contract: a broken or unconfigured attester
// must NEVER yield a verified=true verdict unless DEMO_MODE is explicitly on.
// The dangerous prior behavior silently minted {verified:true, confidence:high}
// when CONFIDENTIAL_AI_API_KEY was unset or the attester call failed.

const CONTENT_TYPE: SupportedContentType = "text/plain";
const GOAL = "got a flu shot this season";
const FILE_B64 = Buffer.from("flu shot administered 2026-01-10").toString(
  "base64",
);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fail-closed verdict", () => {
  it("(a) attester transport failure with DEMO_MODE off -> unverified, not verified:true", async () => {
    // A key is present so the live path is attempted, but the network throws.
    vi.stubEnv("CONFIDENTIAL_AI_API_KEY", "test-key");
    vi.stubEnv("DEMO_MODE", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );

    const attesterId = await submitInference(
      GOAL,
      FILE_B64,
      "flu.txt",
      CONTENT_TYPE,
    );
    // Fail-closed: never a mock id when DEMO_MODE is off.
    expect(isMockId(attesterId)).toBe(false);
    expect(isFailId(attesterId)).toBe(true);

    const { status, verdict } = await pollInference(attesterId, GOAL);
    expect(status).toBe("failed");
    expect(verdict?.verified).toBe(false);
  });

  it("(a2) attester non-2xx on submit with DEMO_MODE off -> unverified", async () => {
    vi.stubEnv("CONFIDENTIAL_AI_API_KEY", "test-key");
    vi.stubEnv("DEMO_MODE", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("upstream 503", { status: 503 }),
        ),
      ),
    );

    const attesterId = await submitInference(
      GOAL,
      FILE_B64,
      "flu.txt",
      CONTENT_TYPE,
    );
    expect(isFailId(attesterId)).toBe(true);

    const { status, verdict } = await pollInference(attesterId, GOAL);
    expect(status).toBe("failed");
    expect(verdict?.verified).toBe(false);
  });

  it("(b) missing API key with DEMO_MODE off -> unverified, not verified:true", async () => {
    vi.stubEnv("CONFIDENTIAL_AI_API_KEY", "");
    vi.stubEnv("DEMO_MODE", "");

    const attesterId = await submitInference(
      GOAL,
      FILE_B64,
      "flu.txt",
      CONTENT_TYPE,
    );
    expect(isMockId(attesterId)).toBe(false);
    expect(isFailId(attesterId)).toBe(true);

    const { status, verdict } = await pollInference(attesterId, GOAL);
    expect(status).toBe("failed");
    expect(verdict?.verified).toBe(false);
  });

  it("(b2) poll with a fail id always stays unverified, even if DEMO_MODE flips on mid-flight", async () => {
    // submit fails closed...
    vi.stubEnv("CONFIDENTIAL_AI_API_KEY", "");
    vi.stubEnv("DEMO_MODE", "");
    const attesterId = await submitInference(
      GOAL,
      FILE_B64,
      "flu.txt",
      CONTENT_TYPE,
    );
    expect(isFailId(attesterId)).toBe(true);

    // ...and even if DEMO_MODE is later enabled, a fail id never becomes verified.
    vi.stubEnv("DEMO_MODE", "true");
    const { status, verdict } = await pollInference(attesterId, GOAL);
    expect(status).toBe("failed");
    expect(verdict?.verified).toBe(false);
  });

  it("(b3) a CLIENT-SUPPLIED mock id is refused even when a real key is configured", async () => {
    // attesterId arrives straight from the /api/agent/run/<goalId> request body,
    // so a caller can hand pollInference a "mock-" id directly without ever going
    // through submitInference. If that short-circuited to the mock verdict,
    // anyone could mint {verified:true, confidence:high} for a goal they never
    // met, have it written to HealthPools at a 2x multiplier, and open the
    // HealthVerdict settlement gate. Having a real API key configured must not
    // change that — the check happens before the key is ever read.
    vi.stubEnv("CONFIDENTIAL_AI_API_KEY", "test-key");
    vi.stubEnv("DEMO_MODE", "");
    vi.spyOn(console, "error").mockImplementation(() => {});

    for (const forged of ["mock-", "mock-0", `mock-${"x".repeat(48)}`]) {
      const { status, verdict } = await pollInference(forged, GOAL);
      expect(status, forged).toBe("failed");
      expect(verdict?.verified, forged).toBe(false);
    }
  });

  it("(c) DEMO_MODE on with no key -> mock path still works (verified:true)", async () => {
    vi.stubEnv("CONFIDENTIAL_AI_API_KEY", "");
    vi.stubEnv("DEMO_MODE", "true");

    const attesterId = await submitInference(
      GOAL,
      FILE_B64,
      "flu.txt",
      CONTENT_TYPE,
    );
    expect(isMockId(attesterId)).toBe(true);

    const { status, verdict } = await pollInference(attesterId, GOAL);
    expect(status).toBe("completed");
    expect(verdict?.verified).toBe(true);
    expect(verdict?.confidence).toBe("high");
  });

  it('(c2) DEMO_MODE="1" is also accepted as on', async () => {
    vi.stubEnv("CONFIDENTIAL_AI_API_KEY", "");
    vi.stubEnv("DEMO_MODE", "1");

    const attesterId = await submitInference(
      GOAL,
      FILE_B64,
      "flu.txt",
      CONTENT_TYPE,
    );
    expect(isMockId(attesterId)).toBe(true);

    const { verdict } = await pollInference(attesterId, GOAL);
    expect(verdict?.verified).toBe(true);
  });

  it("happy path: a real completed verified verdict is still honored", async () => {
    vi.stubEnv("CONFIDENTIAL_AI_API_KEY", "test-key");
    vi.stubEnv("DEMO_MODE", "");

    // submit -> 202 with a real id; poll -> completed verified verdict.
    const calls = vi.fn((url: string) => {
      if (url.endsWith("/v1/inference")) {
        return Promise.resolve(
          Response.json({ id: "real-123", status: "queued" }, { status: 202 }),
        );
      }
      return Promise.resolve(
        Response.json({
          status: "completed",
          output:
            '{"verified": true, "confidence": "high", "reason": "flu shot present"}',
        }),
      );
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => calls(String(input))),
    );

    const attesterId = await submitInference(
      GOAL,
      FILE_B64,
      "flu.txt",
      CONTENT_TYPE,
    );
    expect(attesterId).toBe("real-123");
    expect(isFailId(attesterId)).toBe(false);
    expect(isMockId(attesterId)).toBe(false);

    const { status, verdict } = await pollInference(attesterId, GOAL);
    expect(status).toBe("completed");
    expect(verdict?.verified).toBe(true);
    expect(verdict?.confidence).toBe("high");
  });
});
