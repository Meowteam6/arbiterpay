// PDF handling. The unreadable-PDF path is deterministic with or without
// poppler installed (both extractions fail either way), so it always runs.
// The real-extraction test needs poppler-utils and skips cleanly where the
// tools are absent; it runs for real inside the Docker image and on the VM.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { extractPdf } from "../src/pdf.js";
import { runInference } from "../src/inference.js";
import type { ShimConfig } from "../src/config.js";
import { startFakeOllama } from "./fake-ollama.js";

const hasPoppler =
  spawnSync("pdftotext", ["-v"]).error === undefined &&
  spawnSync("pdftoppm", ["-v"]).error === undefined;

/** Minimal single-page PDF with real extractable text, built programmatically. */
function minimalPdf(text: string): Buffer {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${content.length} >> stream\n${content}endstream endobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
  ];
  // No xref table; poppler reconstructs it from the object stream.
  return Buffer.from(
    `%PDF-1.4\n${objects.join("")}trailer << /Size 6 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`,
  );
}

describe("unreadable PDFs fail closed", () => {
  it("tells the model the PDF was unreadable instead of dropping it silently", async () => {
    const fake = await startFakeOllama();
    try {
      const config: ShimConfig = {
        apiKey: "test-shim-key",
        ollamaUrl: fake.url,
        model: "gemma3:4b-it-qat",
        dataDir: ".",
        port: 0,
        inferenceTimeoutMs: 5_000,
      };
      await runInference(config, {
        systemPrompt: "judge strictly",
        prompt: "did this person get a flu shot",
        resources: [
          {
            filename: "broken.pdf",
            contentType: "application/pdf",
            bytes: Buffer.from("this is not a pdf at all"),
          },
        ],
      });
      const user = fake.requests[0]?.messages[1];
      expect(user?.content).toContain("could not be rendered or read");
      expect(user?.content).toContain("Treat it as unreadable");
      expect(user?.images).toBeUndefined();
    } finally {
      await fake.close();
    }
  });
});

describe.skipIf(hasPoppler === false)("poppler extraction", () => {
  it("renders the first page to PNG and extracts a text excerpt", async () => {
    const pdf = minimalPdf("flu shot administered 2026-01-10");
    const { pageImage, textExcerpt } = await extractPdf(pdf);
    expect(textExcerpt).toContain("flu shot administered 2026-01-10");
    expect(pageImage).not.toBeNull();
    // PNG magic bytes.
    expect(pageImage?.subarray(0, 4).toString("hex")).toBe("89504e47");
  });
});
