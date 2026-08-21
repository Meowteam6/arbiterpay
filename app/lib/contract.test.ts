// The proof-modality taxonomy encoded in a pool's on-chain goalSpec. Pinned
// here: the marker parse, the serializer, that the two legacy conventions
// (unmarked -> wearable, "[doc]" -> document) resolve to the exact policy they
// always did, that a pure-wearable or pure-document policy serializes to a
// byte-identical goalSpec (no "[proof=...]" churn), and that the accepted-set
// enforcement refuses a modality a pool does not accept.

import { describe, it, expect } from "vitest";
import {
  claimModalityFor,
  displayGoalSpec,
  evidenceTypeOf,
  proofPolicyOf,
  withDocMarker,
  withProofPolicy,
  type Modality,
  type ProofPolicy,
} from "@/lib/contract";

describe("proofPolicyOf", () => {
  it("resolves an unmarked goal to the wearable floor (legacy)", () => {
    expect(proofPolicyOf("sleep 7h for 7 nights")).toEqual({
      floor: "wearable",
      accepted: ["wearable"],
    });
  });

  it("resolves a legacy [doc] goal to the document floor", () => {
    expect(proofPolicyOf("[doc] upload your flu shot record")).toEqual({
      floor: "document",
      accepted: ["document"],
    });
  });

  it("reads the legacy [doc] marker case- and space-insensitively", () => {
    expect(proofPolicyOf("  [DOC]  lab report").floor).toBe("document");
  });

  it("parses [proof=doc] to a pure document policy", () => {
    expect(proofPolicyOf("[proof=doc] flu shot")).toEqual({
      floor: "document",
      accepted: ["document"],
    });
  });

  it("parses [proof=doc+self] to a document floor that also accepts self", () => {
    expect(proofPolicyOf("[proof=doc+self] flu shot")).toEqual({
      floor: "document",
      accepted: ["document", "self-reported"],
    });
  });

  it("parses [proof=wearable+self] to a wearable floor that also accepts self", () => {
    expect(proofPolicyOf("[proof=wearable+self] sleep streak")).toEqual({
      floor: "wearable",
      accepted: ["wearable", "self-reported"],
    });
  });

  it("parses [proof=self] to a self-reported floor", () => {
    expect(proofPolicyOf("[proof=self] gym selfie daily")).toEqual({
      floor: "self-reported",
      accepted: ["self-reported"],
    });
  });

  it("normalizes token order so the floor always leads", () => {
    expect(proofPolicyOf("[proof=self+doc] x")).toEqual({
      floor: "document",
      accepted: ["document", "self-reported"],
    });
  });

  it("falls back to the legacy interpretation when the marker has no known tokens", () => {
    // "[proof=xyz]" is not a valid policy; the remaining text has no [doc]
    // prefix, so it resolves to the wearable floor rather than an empty set.
    expect(proofPolicyOf("[proof=xyz] whatever")).toEqual({
      floor: "wearable",
      accepted: ["wearable"],
    });
  });
});

describe("evidenceTypeOf backward compatibility", () => {
  it("keeps unmarked goals wearable", () => {
    expect(evidenceTypeOf("run 5k")).toBe("wearable");
  });

  it("keeps [doc] goals document", () => {
    expect(evidenceTypeOf("[doc] flu shot")).toBe("document");
  });

  it("maps a self-reported floor to document (upload-routed)", () => {
    expect(evidenceTypeOf("[proof=self] gym selfie")).toBe("document");
  });

  it("keeps a wearable+self hybrid on the wearable route", () => {
    expect(evidenceTypeOf("[proof=wearable+self] sleep")).toBe("wearable");
  });
});

describe("withProofPolicy serialization", () => {
  it("emits no marker for a pure wearable policy (byte-identical to the raw goal)", () => {
    const goal = "sleep 7h for 7 nights";
    expect(
      withProofPolicy(goal, { floor: "wearable", accepted: ["wearable"] }),
    ).toBe(goal);
  });

  it("emits [doc] for a pure document policy, matching withDocMarker exactly", () => {
    const goal = "upload your flu shot record";
    const serialized = withProofPolicy(goal, {
      floor: "document",
      accepted: ["document"],
    });
    expect(serialized).toBe("[doc] upload your flu shot record");
    expect(serialized).toBe(withDocMarker(goal));
  });

  it("emits [proof=doc+self] for a document floor that opts into self", () => {
    expect(
      withProofPolicy("flu shot", {
        floor: "document",
        accepted: ["document", "self-reported"],
      }),
    ).toBe("[proof=doc+self] flu shot");
  });

  it("emits [proof=wearable+self] for a wearable floor that opts into self", () => {
    expect(
      withProofPolicy("sleep streak", {
        floor: "wearable",
        accepted: ["wearable", "self-reported"],
      }),
    ).toBe("[proof=wearable+self] sleep streak");
  });

  it("emits [proof=self] for a self-reported floor", () => {
    expect(
      withProofPolicy("gym selfie daily", {
        floor: "self-reported",
        accepted: ["self-reported"],
      }),
    ).toBe("[proof=self] gym selfie daily");
  });

  it("round-trips through proofPolicyOf for every policy shape", () => {
    const policies: ProofPolicy[] = [
      { floor: "wearable", accepted: ["wearable"] },
      { floor: "document", accepted: ["document"] },
      { floor: "document", accepted: ["document", "self-reported"] },
      { floor: "wearable", accepted: ["wearable", "self-reported"] },
      { floor: "self-reported", accepted: ["self-reported"] },
    ];
    for (const policy of policies) {
      const spec = withProofPolicy("do the thing", policy);
      expect(proofPolicyOf(spec)).toEqual(policy);
      expect(displayGoalSpec(spec)).toBe("do the thing");
    }
  });

  it("strips an existing marker before re-serializing (no double markers)", () => {
    const once = withProofPolicy("flu shot", {
      floor: "document",
      accepted: ["document", "self-reported"],
    });
    const twice = withProofPolicy(once, {
      floor: "document",
      accepted: ["document"],
    });
    expect(twice).toBe("[doc] flu shot");
  });
});

describe("displayGoalSpec", () => {
  it("strips the legacy [doc] marker", () => {
    expect(displayGoalSpec("[doc] flu shot")).toBe("flu shot");
  });

  it("strips a [proof=...] marker", () => {
    expect(displayGoalSpec("[proof=doc+self] flu shot")).toBe("flu shot");
  });

  it("leaves an unmarked goal untouched", () => {
    expect(displayGoalSpec("sleep 7h")).toBe("sleep 7h");
  });
});

describe("claimModalityFor enforcement", () => {
  const hybrid = proofPolicyOf("[proof=doc+self] flu shot");
  const pureDoc = proofPolicyOf("[doc] flu shot");

  it("defaults to the floor when no modality is requested", () => {
    expect(claimModalityFor(hybrid, undefined)).toEqual({
      ok: true,
      modality: "document",
    });
  });

  it("accepts a requested modality that is in the accepted set", () => {
    expect(claimModalityFor(hybrid, "self-reported")).toEqual({
      ok: true,
      modality: "self-reported",
    });
  });

  it("refuses a modality the pool does not accept", () => {
    // A pure document pool does not accept self-reported evidence.
    expect(claimModalityFor(pureDoc, "self-reported")).toEqual({
      ok: false,
      reason: "not-accepted",
    });
  });

  it("refuses a modality the pool does not accept (wearable on a doc pool)", () => {
    expect(claimModalityFor(pureDoc, "wearable")).toEqual({
      ok: false,
      reason: "not-accepted",
    });
  });

  it("rejects an unknown modality string as invalid", () => {
    expect(claimModalityFor(hybrid, "vibes")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("backward compatibility: an unmarked pool behaves exactly as today", () => {
  it("is identical policy, evidence type, and display to a legacy wearable goal", () => {
    const legacy = "sleep at least 7 hours every night";
    // Nothing about a pre-taxonomy pool changes: no marker, wearable route,
    // and the goal text renders verbatim.
    expect(proofPolicyOf(legacy)).toEqual({
      floor: "wearable",
      accepted: ["wearable"],
    });
    expect(evidenceTypeOf(legacy)).toBe("wearable");
    expect(displayGoalSpec(legacy)).toBe(legacy);
    // And a wearable create path serializes back to the byte-identical string.
    const modalities: Modality[] = ["wearable"];
    expect(
      withProofPolicy(legacy, { floor: "wearable", accepted: modalities }),
    ).toBe(legacy);
  });
});
