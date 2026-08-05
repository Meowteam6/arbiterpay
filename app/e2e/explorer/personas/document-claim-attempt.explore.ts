import fs from "node:fs";
import { Persona } from "../support/persona";
import { expect, test } from "../support/walls";

/**
 * Persona: a user tries to submit a document claim.
 *
 * Money route. Without a joined wallet the claim section should not render
 * at all, and without credentials the evidence pipeline cannot run — every
 * gate encountered on the way (sign-in, join-first, upload refusal) is a
 * finding about how the claim path fails for a real user.
 */
test("user attempts a document claim", async ({ explorer, page }) => {
  const p = new Persona(
    explorer,
    "document-claim-attempt",
    "A user who believes they met their goal wants to upload a document as proof and get paid; they push as far into the claim flow as the product lets them.",
  );

  await p.tryGoto("/pools", "find a pool to claim against");
  await p.settle(3_000);

  const poolLinks = page.locator("a[href^='/pools/']:not([href='/pools/create'])");
  if ((await poolLinks.count()) > 0) {
    await p.tryClick("the first pool card", poolLinks.first());
  } else {
    p.note("no pool cards rendered; opening pool 1 by URL");
    await p.tryGoto("/pools/1", "open a pool detail directly");
  }
  await p.settle(2_000);

  // The claim section only renders for a joined member; for this persona its
  // absence is itself the wall worth photographing.
  const uploadAffordance = page
    .getByRole("button", { name: /upload proof|upload|submit/i })
    .or(page.getByText(/upload proof/i));
  const foundUpload = await p.trySee(
    "a document-upload affordance",
    uploadAffordance.first(),
    { timeoutMs: 12_000 },
  );

  if (foundUpload) {
    await p.tryClick("the upload-proof affordance", uploadAffordance.first(), {
      graceMs: 3_000,
    });
    await p.settle(2_000);
    const fileInput = page.locator("input[type='file']");
    if ((await fileInput.count()) > 0) {
      await p.attempt("offer a small text file as evidence", async () => {
        await fileInput.first().setInputFiles({
          name: "proof.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("explorer-qa placeholder evidence\n"),
        });
      });
      await p.settle(2_000);
      const submit = page.getByRole("button", { name: /submit|send|claim/i });
      if ((await submit.count()) > 0) {
        await p.tryClick("the submit button", submit.first(), { graceMs: 4_000 });
        await p.settle(4_000);
      }
    } else {
      p.note("no file input appeared after the upload affordance — dead end recorded");
    }
  } else {
    p.note(
      "claim section not reachable without joining/signing in — the gate itself is the finding",
    );
    const signIn = page.getByRole("button", { name: /sign in/i });
    if ((await signIn.count()) > 0) {
      await p.tryClick("a sign-in button, to see what the gate does", signIn.first(), {
        graceMs: 3_000,
      });
      await p.settle(2_000);
    }
  }

  const findings = await explorer.finalize();
  expect(fs.existsSync(findings.path)).toBe(true);
});
