import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReasonContext } from "@/lib/server/agent/reason";

// The reason step must never kill a claim: with Gemini unreachable,
// misconfigured, or answering garbage, the deterministic rule decides and the
// ledger note says loudly which path ran.

const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  // A constructor, not an arrow: the module under test calls `new GoogleGenAI`.
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent } };
  }),
}));

function ctx(overrides: Partial<ReasonContext> = {}): ReasonContext {
  return {
    goalSpec: "got a flu shot this season",
    verdict: { verified: true, confidence: "high", reason: "on record" },
    attesterStatus: "completed",
    escalation: { kind: "none" },
    capUsd: "1.00",
    spentUsd: "0.02",
    ...overrides,
  };
}

async function load() {
  vi.resetModules();
  return import("@/lib/server/agent/reason");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("deterministicReason", () => {
  it("pays a completed, verified, non-low verdict", async () => {
    const { deterministicReason } = await load();
    expect(deterministicReason(ctx()).decision).toBe("pay");
  });

  it("refuses low confidence, unverified, and failed inferences", async () => {
    const { deterministicReason } = await load();
    expect(
      deterministicReason(
        ctx({ verdict: { verified: true, confidence: "low", reason: "blur" } }),
      ).decision,
    ).toBe("no-pay");
    expect(
      deterministicReason(
        ctx({ verdict: { verified: false, confidence: "high", reason: "no" } }),
      ).decision,
    ).toBe("no-pay");
    expect(
      deterministicReason(ctx({ attesterStatus: "failed" })).decision,
    ).toBe("no-pay");
  });
});

describe("geminiReason", () => {
  it("falls back loudly when GOOGLE_CLOUD_PROJECT is unset", async () => {
    const { geminiReason } = await load();
    const result = await geminiReason(ctx());
    expect(result.decision).toBe("pay");
    expect(result.note).toMatch(/gemini unavailable/);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("uses the model's JSON decision when it parses", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "gohealthmev2");
    generateContent.mockResolvedValue({
      text: '{"decision": "no-pay", "note": "confidence is thin. not paying."}',
    });
    const { geminiReason } = await load();

    const result = await geminiReason(ctx());

    expect(result).toEqual({
      decision: "no-pay",
      note: "confidence is thin. not paying.",
    });
    const request = generateContent.mock.calls[0][0] as {
      model: string;
      config: { thinkingConfig: { thinkingBudget: number } };
      contents: string;
    };
    expect(request.model).toBe("gemini-2.5-flash");
    // Without a zero thinking budget, 2.5 Flash spends the output budget on
    // thinking tokens and returns empty text.
    expect(request.config.thinkingConfig.thinkingBudget).toBe(0);
    // Derived data only: the prompt must carry the verdict, never a document.
    expect(request.contents).toContain("verified=true");
  });

  it("falls back to the anchor on empty or unparseable output", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "gohealthmev2");
    generateContent.mockResolvedValue({ text: "" });
    const { geminiReason } = await load();

    const result = await geminiReason(ctx());

    expect(result.decision).toBe("pay");
    expect(result.note).toMatch(/no usable decision/);
  });

  it("falls back to the anchor when the call throws", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "gohealthmev2");
    generateContent.mockRejectedValue(new Error("RESOURCE_EXHAUSTED"));
    const { geminiReason } = await load();

    const result = await geminiReason(
      ctx({ verdict: { verified: false, confidence: "low", reason: "blur" } }),
    );

    expect(result.decision).toBe("no-pay");
    expect(result.note).toMatch(/gemini unavailable \(RESOURCE_EXHAUSTED/);
  });
});
