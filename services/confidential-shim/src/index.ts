// Entry point. Loads config, builds the shim, serves it. Meant to run inside
// the docker-compose stack on the Confidential VM, behind Caddy for TLS.

import { serve } from "@hono/node-server";
import { createShim } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = createShim(config);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `[shim] confidential attester shim listening on :${info.port} ` +
      `(model=${config.model} ollama=${config.ollamaUrl})`,
  );
});
