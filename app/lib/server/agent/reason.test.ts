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

describe("inlineCredentials", () => {
  const KEY_ESCAPED =
    "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----\\n";
  const KEY_REPAIRED =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\n";

  it("parses a valid service-account JSON and repairs escaped newlines", async () => {
    vi.stubEnv(
      "GOOGLE_CREDENTIALS_JSON",
      JSON.stringify({
        type: "service_account",
        client_email: "spotter@gohealthmev2.iam.gserviceaccount.com",
        private_key: KEY_ESCAPED,
      }),
    );
    const { inlineCredentials } = await load();
    expect(inlineCredentials()).toEqual({
      client_email: "spotter@gohealthmev2.iam.gserviceaccount.com",
      private_key: KEY_REPAIRED,
    });
  });

  it("passes through a key that already has real newlines", async () => {
    vi.stubEnv(
      "GOOGLE_CREDENTIALS_JSON",
      JSON.stringify({
        client_email: "spotter@gohealthmev2.iam.gserviceaccount.com",
        private_key: KEY_REPAIRED,
      }),
    );
    const { inlineCredentials } = await load();
    expect(inlineCredentials()?.private_key).toBe(KEY_REPAIRED);
  });

  it("returns null when the env var is missing or empty", async () => {
    vi.stubEnv("GOOGLE_CREDENTIALS_JSON", "");
    const { inlineCredentials } = await load();
    expect(inlineCredentials()).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    vi.stubEnv("GOOGLE_CREDENTIALS_JSON", "{not json");
    const { inlineCredentials } = await load();
    expect(inlineCredentials()).toBeNull();
  });

  it("returns null when client_email or private_key is missing or non-string", async () => {
    const { inlineCredentials } = await load();
    for (const bad of [
      { private_key: KEY_ESCAPED },
      { client_email: "spotter@gohealthmev2.iam.gserviceaccount.com" },
      { client_email: 7, private_key: KEY_ESCAPED },
      { client_email: "a@b.c", private_key: 7 },
      { client_email: "", private_key: KEY_ESCAPED },
      { client_email: "a@b.c", private_key: "" },
      null,
      "just a string",
    ]) {
      vi.stubEnv("GOOGLE_CREDENTIALS_JSON", JSON.stringify(bad));
      expect(inlineCredentials(), JSON.stringify(bad)).toBeNull();
    }
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

  it("passes inline credentials to the Vertex client when configured", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "gohealthmev2");
    vi.stubEnv(
      "GOOGLE_CREDENTIALS_JSON",
      JSON.stringify({
        client_email: "spotter@gohealthmev2.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n",
      }),
    );
    generateContent.mockResolvedValue({
      text: '{"decision": "pay", "note": "credentials worked."}',
    });
    const { geminiReason } = await load();

    await geminiReason(ctx());

    const { GoogleGenAI } = await import("@google/genai");
    const options = vi.mocked(GoogleGenAI).mock.calls[0][0] as unknown as {
      vertexai: boolean;
      project: string;
      googleAuthOptions?: {
        credentials: { client_email: string; private_key: string };
        scopes?: unknown;
      };
    };
    expect(options.vertexai).toBe(true);
    expect(options.project).toBe("gohealthmev2");
    expect(options.googleAuthOptions).toEqual({
      credentials: {
        client_email: "spotter@gohealthmev2.iam.gserviceaccount.com",
        private_key:
          "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      },
    });
    // Scopes stay unset so the SDK injects cloud-platform itself.
    expect(options.googleAuthOptions).not.toHaveProperty("scopes");
  });

  it("omits googleAuthOptions entirely when inline credentials are absent", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "gohealthmev2");
    vi.stubEnv("GOOGLE_CREDENTIALS_JSON", "");
    generateContent.mockResolvedValue({
      text: '{"decision": "pay", "note": "adc worked."}',
    });
    const { geminiReason } = await load();

    await geminiReason(ctx());

    const { GoogleGenAI } = await import("@google/genai");
    const options = vi.mocked(GoogleGenAI).mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(options).not.toHaveProperty("googleAuthOptions");
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
