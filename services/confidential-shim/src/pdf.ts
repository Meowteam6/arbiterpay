// PDF handling via poppler-utils (the only non-Node dependency, installed in
// the Docker image). Two extractions per PDF, both best-effort:
//   pdftoppm  first page -> PNG so the vision model can read scans and layout
//   pdftotext first page -> text excerpt appended to the prompt for born-digital
//               PDFs whose text a low-res render might lose
//
// PRIVACY: the PDF bytes must touch disk for poppler, so they go to a private
// mkdtemp directory that is removed in a finally block. Nothing under the
// journal dataDir ever sees document bytes.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const execFileP = promisify(execFile);

const TOOL_TIMEOUT_MS = 60_000;

/** Cap on the text excerpt appended to the prompt. */
export const PDF_TEXT_EXCERPT_LIMIT = 4_000;

export interface PdfExtraction {
  /** PNG render of the first page, or null when pdftoppm failed. */
  pageImage: Buffer | null;
  /** First-page text excerpt (possibly empty) when pdftotext succeeded. */
  textExcerpt: string;
}

export async function extractPdf(pdfBytes: Buffer): Promise<PdfExtraction> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shim-pdf-"));
  const pdfPath = path.join(tempDir, "doc.pdf");
  try {
    await fs.writeFile(pdfPath, pdfBytes);

    let pageImage: Buffer | null = null;
    try {
      await execFileP(
        "pdftoppm",
        ["-png", "-f", "1", "-l", "1", "-r", "150", pdfPath, path.join(tempDir, "page")],
        { timeout: TOOL_TIMEOUT_MS },
      );
      // pdftoppm pads the page number by document length; find the file
      // instead of guessing the name.
      const rendered = (await fs.readdir(tempDir)).find(
        (name) => name.startsWith("page") && name.endsWith(".png"),
      );
      if (rendered !== undefined) {
        pageImage = await fs.readFile(path.join(tempDir, rendered));
      }
    } catch {
      pageImage = null;
    }

    let textExcerpt = "";
    try {
      const { stdout } = await execFileP(
        "pdftotext",
        ["-f", "1", "-l", "1", pdfPath, "-"],
        { timeout: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      );
      textExcerpt = stdout.trim().slice(0, PDF_TEXT_EXCERPT_LIMIT);
    } catch {
      textExcerpt = "";
    }

    return { pageImage, textExcerpt };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
