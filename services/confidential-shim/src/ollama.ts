// Ollama client. One call per inference: POST /api/chat with the hardened
// system prompt, the user prompt (plus any extracted document text), image
// resources as base64, and format-constrained decoding pinned to the verdict
// JSON schema so the model cannot answer in prose. Temperature 0 for
// reproducible verdicts.

/**
 * JSON schema for the verdict struct, passed as Ollama's `format` for
 * constrained decoding. Must stay in lockstep with the app-side Verdict type
 * in app/lib/server/judge.ts.
 */
export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verified: { type: "boolean" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    reason: { type: "string" },
  },
  required: ["verified", "confidence", "reason"],
} as const;

export interface ChatVerdictArgs {
  ollamaUrl: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  /** Base64-encoded images (PNG/JPEG bytes, or a rendered PDF page). */
  images: string[];
  timeoutMs: number;
}

/**
 * Run one chat completion and return the raw model text (the verdict JSON).
 * Throws on transport errors, non-2xx, timeout, or a malformed Ollama
 * response; the worker converts a throw into job status "failed", which the
 * app resolves to an unverified verdict. Fail closed, never fail silent.
 */
export async function chatVerdict(args: ChatVerdictArgs): Promise<string> {
  const userMessage: Record<string, unknown> = {
    role: "user",
    content: args.prompt,
  };
  if (args.images.length > 0) {
    userMessage.images = args.images;
  }

  let res: Response;
  try {
    res = await fetch(`${args.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        stream: false,
        messages: [
          { role: "system", content: args.systemPrompt },
          userMessage,
        ],
        format: VERDICT_SCHEMA,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (err) {
    throw new Error(`model server unreachable: ${String(err)}`);
  }

  if (res.ok === false) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `model server returned HTTP ${res.status}: ${detail.slice(0, 300)}`,
    );
  }

  let payload: { message?: { content?: unknown } };
  try {
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    throw new Error(`model server returned unreadable JSON: ${String(err)}`);
  }

  const content = payload.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("model server response had no message content");
  }
  return content;
}

export interface ModelHealth {
  reachable: boolean;
  modelPresent: boolean;
  detail: string;
}

/**
 * Health probe: is Ollama reachable, and is the configured model pulled.
 * Never throws; /healthz turns the result into 200 or 503.
 */
export async function checkModel(
  ollamaUrl: string,
  model: string,
): Promise<ModelHealth> {
  let res: Response;
  try {
    res = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    return {
      reachable: false,
      modelPresent: false,
      detail: `ollama unreachable: ${String(err)}`,
    };
  }
  if (res.ok === false) {
    return {
      reachable: false,
      modelPresent: false,
      detail: `ollama returned HTTP ${res.status}`,
    };
  }
  let payload: { models?: unknown };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    return {
      reachable: true,
      modelPresent: false,
      detail: "ollama /api/tags returned unreadable JSON",
    };
  }
  const names = Array.isArray(payload.models)
    ? payload.models
        .map((m) =>
          m !== null && typeof m === "object" && "name" in m
            ? String((m as { name: unknown }).name)
            : "",
        )
        .filter((n) => n !== "")
    : [];
  const modelPresent = names.includes(model);
  return {
    reachable: true,
    modelPresent,
    detail: modelPresent
      ? `model ${model} present`
      : `model ${model} not pulled; available: ${names.join(", ") || "none"}`,
  };
}
