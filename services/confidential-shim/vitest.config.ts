import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Tests spin up real (fake-Ollama) HTTP servers and temp journal dirs;
    // serial execution keeps port and filesystem state simple to reason about.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
