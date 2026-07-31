// Shim configuration. Everything comes from env with safe defaults so the same
// build runs in docker-compose on the Confidential VM and under vitest with a
// fake Ollama. SHIM_API_KEY has no default on purpose: an unauthenticated
// verdict service would let anyone mint verdicts, so startup fails loudly
// without it.

export interface ShimConfig {
  /** Bearer key clients must present. Maps to CONFIDENTIAL_AI_API_KEY app-side. */
  apiKey: string;
  /** Base URL of the Ollama server, no trailing slash. */
  ollamaUrl: string;
  /** Ollama model tag that actually serves inference. */
  model: string;
  /** Directory for per-job JSON metadata journals. Never holds document bytes. */
  dataDir: string;
  /** HTTP listen port. */
  port: number;
  /** Per-inference Ollama timeout. Generous: cold model loads are slow. */
  inferenceTimeoutMs: number;
}

function trimmedEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return value.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ShimConfig {
  const apiKey = trimmedEnv(env, "SHIM_API_KEY", "");
  if (apiKey === "") {
    throw new Error(
      "SHIM_API_KEY must be set. It is the bearer key the app presents as " +
        "CONFIDENTIAL_AI_API_KEY; refusing to serve verdicts unauthenticated.",
    );
  }
  const port = Number.parseInt(trimmedEnv(env, "PORT", "8080"), 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error("PORT must be a valid TCP port number.");
  }
  return {
    apiKey,
    ollamaUrl: trimmedEnv(env, "OLLAMA_URL", "http://localhost:11434").replace(
      /\/+$/,
      "",
    ),
    model: trimmedEnv(env, "SHIM_MODEL", "gemma3:4b-it-qat"),
    dataDir: trimmedEnv(env, "SHIM_DATA_DIR", "./data/jobs"),
    port,
    inferenceTimeoutMs: 10 * 60 * 1000,
  };
}
