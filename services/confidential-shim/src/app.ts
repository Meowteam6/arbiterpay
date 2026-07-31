// HTTP surface. Replicates the Chainlink Confidential AI Attester contract the
// app already speaks (app/lib/server/judge.ts) so switching to the shim is one
// env flip, CONFIDENTIAL_AI_BASE_URL, and nothing else:
//   POST /v1/inference        -> 202 { id, status: "queued" }
//   GET  /v1/inference/:id    -> 200 { id, status, output?, error? }
//   GET  /v1/models           -> { models: [{ id: "gemma4" }] }
//   GET  /healthz             -> model-server reachability (no auth)
// Clients ask for model "gemma4" (the attester's name); the shim serves it
// with the local Ollama model from SHIM_MODEL.

import { Hono } from "hono";
import { bearerMatches } from "./auth.js";
import type { ShimConfig } from "./config.js";
import { runInference } from "./inference.js";
import {
  JobStore,
  type JobResource,
  type SupportedContentType,
} from "./jobs.js";
import { checkModel } from "./ollama.js";
import { InferenceWorker, type InferenceRunner } from "./worker.js";

/** The model id the attester contract exposes; requests for anything else 400. */
export const PUBLIC_MODEL_ID = "gemma4";

export const MAX_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;

const SUPPORTED_CONTENT_TYPES: readonly SupportedContentType[] = [
  "image/png",
  "image/jpeg",
  "application/pdf",
  "text/plain",
];

function isSupportedContentType(value: string): value is SupportedContentType {
  return (SUPPORTED_CONTENT_TYPES as readonly string[]).includes(value);
}

export interface Shim {
  app: Hono;
  store: JobStore;
  worker: InferenceWorker;
}

/**
 * Build the shim. `runner` is injectable for tests; production uses the real
 * Ollama-backed runInference.
 */
export function createShim(config: ShimConfig, runner?: InferenceRunner): Shim {
  const store = new JobStore(config.dataDir);
  const worker = new InferenceWorker(
    store,
    runner ?? ((payload) => runInference(config, payload)),
  );
  const app = new Hono();

  // Health is unauthenticated so load balancers and demo-morning checklists
  // can probe it. It reports reachability and model presence, never job data.
  app.get("/healthz", async (c) => {
    const health = await checkModel(config.ollamaUrl, config.model);
    const healthy = health.reachable && health.modelPresent;
    return c.json(
      {
        status: healthy ? "ok" : "unavailable",
        model: config.model,
        detail: health.detail,
      },
      healthy ? 200 : 503,
    );
  });

  // Everything under /v1 requires the bearer key.
  app.use("/v1/*", async (c, next) => {
    if (bearerMatches(c.req.header("authorization"), config.apiKey) === false) {
      return c.json({ error: "missing or invalid bearer token" }, 401);
    }
    await next();
  });

  app.get("/v1/models", (c) => c.json({ models: [{ id: PUBLIC_MODEL_ID }] }));

  app.post("/v1/inference", async (c) => {
    const declaredLength = Number.parseInt(
      c.req.header("content-length") ?? "0",
      10,
    );
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return c.json({ error: "request body exceeds 32MB" }, 413);
    }

    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return c.json({ error: "request body exceeds 32MB" }, 413);
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") {
        return c.json({ error: "request body must be a JSON object" }, 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return c.json({ error: "request body is not valid JSON" }, 400);
    }

    if (body.model !== PUBLIC_MODEL_ID) {
      return c.json(
        { error: `unknown model; only '${PUBLIC_MODEL_ID}' is served` },
        400,
      );
    }
    if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
      return c.json({ error: "prompt must be a non-empty string" }, 400);
    }
    if (
      body.system_prompt !== undefined &&
      typeof body.system_prompt !== "string"
    ) {
      return c.json({ error: "system_prompt must be a string" }, 400);
    }

    const resources: JobResource[] = [];
    if (body.resources !== undefined) {
      if (Array.isArray(body.resources) === false) {
        return c.json({ error: "resources must be an array" }, 400);
      }
      for (const entry of body.resources as unknown[]) {
        if (entry === null || typeof entry !== "object") {
          return c.json({ error: "each resource must be an object" }, 400);
        }
        const resource = entry as Record<string, unknown>;
        if (typeof resource.filename !== "string") {
          return c.json({ error: "resource filename must be a string" }, 400);
        }
        if (
          typeof resource.content_type !== "string" ||
          isSupportedContentType(resource.content_type) === false
        ) {
          return c.json(
            {
              error:
                "unsupported content_type; expected one of " +
                SUPPORTED_CONTENT_TYPES.join(", "),
            },
            400,
          );
        }
        if (typeof resource.content_base64 !== "string") {
          return c.json(
            { error: "resource content_base64 must be a string" },
            400,
          );
        }
        const bytes = Buffer.from(resource.content_base64, "base64");
        if (bytes.length > MAX_RESOURCE_BYTES) {
          return c.json({ error: "decoded resource exceeds 8MB" }, 413);
        }
        resources.push({
          filename: resource.filename,
          contentType: resource.content_type,
          bytes,
        });
      }
    }

    const meta = store.create({
      systemPrompt: typeof body.system_prompt === "string" ? body.system_prompt : "",
      prompt: body.prompt,
      resources,
    });
    worker.enqueue(meta.id);
    // Log only metadata, never document bytes or prompt text.
    console.log(
      `[shim] inference queued id=${meta.id} resources=${resources.length}`,
    );
    return c.json({ id: meta.id, status: "queued" }, 202);
  });

  app.get("/v1/inference/:id", (c) => {
    const meta = store.get(c.req.param("id"));
    if (meta === undefined) {
      return c.json({ error: "unknown inference id" }, 404);
    }
    return c.json({
      id: meta.id,
      status: meta.status,
      ...(meta.output !== undefined ? { output: meta.output } : {}),
      ...(meta.error !== undefined ? { error: meta.error } : {}),
    });
  });

  return { app, store, worker };
}
