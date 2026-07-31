// Contract tests against a fake Ollama. These pin the exact HTTP surface
// app/lib/server/judge.ts speaks to the hosted Chainlink attester, so the shim
// stays a drop-in replacement: flip CONFIDENTIAL_AI_BASE_URL and nothing else.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createShim, type Shim } from "../src/app.js";
import type { ShimConfig } from "../src/config.js";
import {
  startFakeOllama,
  type FakeOllama,
  type FakeChatRequest,
} from "./fake-ollama.js";

const API_KEY = "test-shim-key";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STRICT_VERDICT =
  '{"verified": true, "confidence": "high", "reason": "flu shot present"}';

let fake: FakeOllama;
let shim: Shim;
let dataDir: string;

function config(overrides: Partial<ShimConfig> = {}): ShimConfig {
  return {
    apiKey: API_KEY,
    ollamaUrl: fake.url,
    model: "gemma3:4b-it-qat",
    dataDir,
    port: 0,
    inferenceTimeoutMs: 5_000,
    ...overrides,
  };
}

function authHeaders(key: string = API_KEY): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

interface SubmitOverrides {
  model?: unknown;
  prompt?: unknown;
  resources?: unknown;
  key?: string;
}

async function submit(overrides: SubmitOverrides = {}): Promise<Response> {
  const body = {
    model: overrides.model !== undefined ? overrides.model : "gemma4",
    system_prompt:
      "You are a health verification analyst. Judge strictly from the documents' contents.",
    prompt:
      overrides.prompt !== undefined
        ? overrides.prompt
        : "Based on the attached document(s), did this person satisfy this goal: 'got a flu shot this season'?",
    resources:
      overrides.resources !== undefined
        ? overrides.resources
        : [
            {
              filename: "flu.txt",
              content_type: "text/plain",
              content_base64: Buffer.from(
                "flu shot administered 2026-01-10",
              ).toString("base64"),
            },
          ],
  };
  return shim.app.request("/v1/inference", {
    method: "POST",
    headers: authHeaders(overrides.key ?? API_KEY),
    body: JSON.stringify(body),
  });
}

async function poll(id: string, key: string = API_KEY): Promise<Response> {
  return shim.app.request(`/v1/inference/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${key}` },
  });
}

async function pollBody(id: string): Promise<{
  id: string;
  status: string;
  output?: string;
  error?: string;
}> {
  const res = await poll(id);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    id: string;
    status: string;
    output?: string;
    error?: string;
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (predicate() === false) {
    expect(Date.now()).toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(async () => {
  fake = await startFakeOllama();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-test-"));
  shim = createShim(config());
});

afterEach(async () => {
  await shim.worker.idle();
  await fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("bearer auth", () => {
  it("rejects a missing bearer with 401", async () => {
    const res = await shim.app.request("/v1/inference", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemma4", prompt: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer with 401 on submit, poll, and models", async () => {
    expect((await submit({ key: "wrong-key" })).status).toBe(401);
    expect((await poll("any-id", "wrong-key")).status).toBe(401);
    const models = await shim.app.request("/v1/models", {
      headers: { authorization: "Bearer wrong-key" },
    });
    expect(models.status).toBe(401);
  });

  it("serves the model list with the right bearer", async () => {
    const res = await shim.app.request("/v1/models", {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [{ id: "gemma4" }] });
  });
});

describe("submit validation", () => {
  it("happy path returns 202 with a uuid id and queued status", async () => {
    const res = await submit();
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toMatch(UUID_RE);
    expect(body.status).toBe("queued");
  });

  it("rejects any model other than gemma4 with 400", async () => {
    for (const model of ["gemma3", "gpt-4", "", null]) {
      const res = await submit({ model });
      expect(res.status, String(model)).toBe(400);
    }
    const missingModel = await shim.app.request("/v1/inference", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(missingModel.status).toBe(400);
  });

  it("rejects an unsupported content_type with 400", async () => {
    const res = await submit({
      resources: [
        {
          filename: "x.gif",
          content_type: "image/gif",
          content_base64: Buffer.from("nope").toString("base64"),
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rejects a decoded resource over 8MB with 413", async () => {
    const res = await submit({
      resources: [
        {
          filename: "big.png",
          content_type: "image/png",
          content_base64: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"),
        },
      ],
    });
    expect(res.status).toBe(413);
  });

  it("rejects a request body over 32MB with 413", async () => {
    const res = await shim.app.request("/v1/inference", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "gemma4",
        prompt: "x",
        padding: "x".repeat(33 * 1024 * 1024),
      }),
    });
    expect(res.status).toBe(413);
  });

  it("rejects malformed JSON and a missing prompt with 400", async () => {
    const malformed = await shim.app.request("/v1/inference", {
      method: "POST",
      headers: authHeaders(),
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect((await submit({ prompt: "" })).status).toBe(400);
    expect((await submit({ prompt: 7 })).status).toBe(400);
  });
});

describe("inference flow", () => {
  it("runs FIFO: first job running, second queued, both complete in order", async () => {
    const releases: Array<(content: string) => void> = [];
    fake.setResponder(
      () =>
        new Promise((resolve) =>
          releases.push((content: string) => resolve({ content })),
        ),
    );

    const first = (await (await submit()).json()) as { id: string };
    const second = (await (await submit()).json()) as { id: string };

    // Concurrency 1: only the first job reaches the model server.
    await waitFor(() => fake.requests.length === 1);
    expect((await pollBody(first.id)).status).toBe("running");
    expect((await pollBody(second.id)).status).toBe("queued");

    releases[0]?.(STRICT_VERDICT);
    await waitFor(() => fake.requests.length === 2);
    expect((await pollBody(first.id)).status).toBe("completed");
    expect((await pollBody(second.id)).status).toBe("running");

    releases[1]?.(STRICT_VERDICT);
    await shim.worker.idle();

    const done = await pollBody(second.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe(STRICT_VERDICT);
  });

  it("marks the job failed when the model server errors", async () => {
    fake.setResponder(async () => ({ status: 500 }));
    const { id } = (await (await submit()).json()) as { id: string };
    await shim.worker.idle();

    const body = await pollBody(id);
    expect(body.status).toBe("failed");
    expect(body.error).toMatch(/HTTP 500/);
    expect(body.output).toBeUndefined();
  });

  it("marks the job failed when the model returns empty content", async () => {
    fake.setResponder(async () => ({ content: "" }));
    const { id } = (await (await submit()).json()) as { id: string };
    await shim.worker.idle();

    expect((await pollBody(id)).status).toBe("failed");
  });

  it("returns 404 for an unknown inference id", async () => {
    const res = await poll("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

describe("what the model receives", () => {
  function lastRequest(): FakeChatRequest {
    const request = fake.requests[fake.requests.length - 1];
    expect(request).toBeDefined();
    return request as FakeChatRequest;
  }

  it("hardens the client system prompt to fail closed and pins the schema", async () => {
    await (await submit()).json();
    await shim.worker.idle();

    const request = lastRequest();
    const system = request.messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("health verification analyst");
    expect(system?.content).toContain("fail closed");
    expect(system?.content).toContain("set verified to false");
    // Constrained decoding: the format field carries the verdict schema.
    expect(request.format).toMatchObject({
      type: "object",
      required: ["verified", "confidence", "reason"],
    });
    expect(request.options?.temperature).toBe(0);
    expect(request.stream).toBe(false);
  });

  it("appends text/plain content to the prompt and passes images as base64", async () => {
    const pngBase64 = Buffer.from("fake-png-bytes").toString("base64");
    await (
      await submit({
        resources: [
          {
            filename: "flu.txt",
            content_type: "text/plain",
            content_base64: Buffer.from(
              "flu shot administered 2026-01-10",
            ).toString("base64"),
          },
          {
            filename: "scan.png",
            content_type: "image/png",
            content_base64: pngBase64,
          },
        ],
      })
    ).json();
    await shim.worker.idle();

    const user = lastRequest().messages[1];
    expect(user?.role).toBe("user");
    expect(user?.content).toContain("did this person satisfy this goal");
    expect(user?.content).toContain("flu shot administered 2026-01-10");
    expect(user?.images).toEqual([pngBase64]);
  });

  it("never writes document bytes to the job journal", async () => {
    const secret = "SECRET-DOCUMENT-CONTENT-NEVER-PERSIST";
    const { id } = (await (
      await submit({
        resources: [
          {
            filename: "secret.txt",
            content_type: "text/plain",
            content_base64: Buffer.from(secret).toString("base64"),
          },
        ],
      })
    ).json()) as { id: string };
    await shim.worker.idle();

    const journal = fs.readFileSync(path.join(dataDir, `${id}.json`), "utf8");
    expect(journal).not.toContain(secret);
    expect(journal).not.toContain(Buffer.from(secret).toString("base64"));
    const parsed = JSON.parse(journal) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "created_at",
      "id",
      "output",
      "status",
      "updated_at",
    ]);
  });
});

// Copy of parseVerdict from app/lib/server/judge.ts. The shim's output must
// keep passing the app's tolerance rules; if judge.ts changes its parsing,
// this copy is the tripwire that forces the contract conversation.
type Confidence = "low" | "medium" | "high";
interface Verdict {
  verified: boolean;
  confidence: Confidence;
  reason: string;
}

function failedVerdict(reason: string): Verdict {
  return { verified: false, confidence: "low", reason };
}

function parseVerdict(output: string): Verdict {
  const stripped = output.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return failedVerdict("Verification enclave returned no structured verdict.");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
  } catch {
    return failedVerdict("Verification enclave returned an unexpected format.");
  }
  const verified = parsed.verified === true;
  const confidence: Confidence =
    parsed.confidence === "high" ||
    parsed.confidence === "medium" ||
    parsed.confidence === "low"
      ? parsed.confidence
      : "low";
  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim() !== ""
      ? parsed.reason
      : "No reason provided by the verification enclave.";
  return { verified, confidence, reason };
}

describe("shim output stays parseable under judge.ts rules", () => {
  const cases: Array<{
    name: string;
    modelOutput: string;
    expected: Partial<Verdict>;
  }> = [
    {
      // The judge.test.ts happy-path fixture, verbatim.
      name: "strict JSON verdict",
      modelOutput: STRICT_VERDICT,
      expected: { verified: true, confidence: "high", reason: "flu shot present" },
    },
    {
      name: "verdict wrapped in a json code fence",
      modelOutput: "```json\n" + STRICT_VERDICT + "\n```",
      expected: { verified: true, confidence: "high" },
    },
    {
      name: "verdict surrounded by stray prose",
      modelOutput: `Sure, here is the verdict: ${STRICT_VERDICT} hope that helps`,
      expected: { verified: true, confidence: "high" },
    },
    {
      name: "unverified medium-confidence verdict",
      modelOutput:
        '{"verified": false, "confidence": "medium", "reason": "document is off-topic"}',
      expected: { verified: false, confidence: "medium" },
    },
    {
      name: "unknown confidence collapses to low",
      modelOutput:
        '{"verified": true, "confidence": "certain", "reason": "x"}',
      expected: { verified: true, confidence: "low" },
    },
    {
      name: "no structured verdict fails closed",
      modelOutput: "i cannot help with that",
      expected: { verified: false, confidence: "low" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      fake.setResponder(async () => ({ content: testCase.modelOutput }));
      const { id } = (await (await submit()).json()) as { id: string };
      await shim.worker.idle();

      const body = await pollBody(id);
      expect(body.status).toBe("completed");
      expect(body.output).toBe(testCase.modelOutput);
      const verdict = parseVerdict(body.output ?? "");
      expect(verdict).toMatchObject(testCase.expected);
    });
  }
});

describe("healthz", () => {
  it("returns 200 without auth when ollama serves the model", async () => {
    const res = await shim.app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("returns 503 when the configured model is not pulled", async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-test-"));
    try {
      const missing = createShim(config({ model: "not-pulled:latest", dataDir: otherDir }));
      const res = await missing.app.request("/healthz");
      expect(res.status).toBe(503);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("returns 503 when ollama is unreachable", async () => {
    await fake.close();
    const res = await shim.app.request("/healthz");
    expect(res.status).toBe(503);
    // Restart so afterEach close() has a live server to close.
    fake = await startFakeOllama();
  });
});
