import { describe, it, expect } from "vitest";
import {
  COACH_CHECKLIST,
  coachCopy,
  isPoolDetailPath,
  resolveCoachStep,
  type CoachInputs,
} from "@/lib/help/coach";

function inputs(overrides: Partial<CoachInputs> = {}): CoachInputs {
  return {
    authenticated: true,
    balance: 1_000_000n,
    handleClaimed: true,
    pathname: "/",
    ...overrides,
  };
}

describe("resolveCoachStep", () => {
  it("signIn when not authenticated, regardless of other signals", () => {
    const step = resolveCoachStep(
      inputs({ authenticated: false, balance: 0n, handleClaimed: false }),
    );
    expect(step.id).toBe("signIn");
    expect(step.index).toBe(0);
    expect(step.loading).toBe(false);
  });

  it("holds on getUsdc with loading while the balance is unknown", () => {
    const step = resolveCoachStep(inputs({ balance: undefined }));
    expect(step.id).toBe("getUsdc");
    expect(step.loading).toBe(true);
  });

  it("getUsdc when authenticated and balance is zero", () => {
    const step = resolveCoachStep(inputs({ balance: 0n }));
    expect(step.id).toBe("getUsdc");
    expect(step.index).toBe(1);
    expect(step.loading).toBe(false);
  });

  it("claimHandle when funded but no handle", () => {
    const step = resolveCoachStep(inputs({ handleClaimed: false }));
    expect(step.id).toBe("claimHandle");
    expect(step.index).toBe(2);
  });

  it("doTheThing when funded and handle claimed", () => {
    const step = resolveCoachStep(inputs());
    expect(step.id).toBe("doTheThing");
    expect(step.index).toBe(3);
  });

  it("overrides to uploadProof on a funded pool-detail page", () => {
    const step = resolveCoachStep(
      inputs({ pathname: "/pools/42", handleClaimed: false }),
    );
    expect(step.id).toBe("uploadProof");
    expect(step.index).toBe(4);
  });

  it("does NOT override to uploadProof when unfunded on a pool page", () => {
    const step = resolveCoachStep(inputs({ pathname: "/pools/42", balance: 0n }));
    expect(step.id).toBe("getUsdc");
  });

  it("does NOT treat /pools/create as a pool-detail page", () => {
    const step = resolveCoachStep(inputs({ pathname: "/pools/create" }));
    expect(step.id).toBe("doTheThing");
  });
});

describe("isPoolDetailPath", () => {
  it("matches a pool id, not the list, create, or nested routes", () => {
    expect(isPoolDetailPath("/pools/7")).toBe(true);
    expect(isPoolDetailPath("/pools/7/")).toBe(true);
    expect(isPoolDetailPath("/pools")).toBe(false);
    expect(isPoolDetailPath("/pools/create")).toBe(false);
    expect(isPoolDetailPath("/pools/7/proof")).toBe(false);
    expect(isPoolDetailPath("/")).toBe(false);
  });
});

describe("checklist and copy", () => {
  it("always has six rows ending in the gold Get paid row", () => {
    expect(COACH_CHECKLIST).toHaveLength(6);
    const last = COACH_CHECKLIST[COACH_CHECKLIST.length - 1];
    expect(last.id).toBe("paid");
    expect(last.gold).toBe(true);
  });

  it("has scripted copy with no exclamation marks for every action", () => {
    for (const id of [
      "signIn",
      "getUsdc",
      "claimHandle",
      "doTheThing",
      "uploadProof",
    ] as const) {
      const copy = coachCopy(id);
      expect(copy.headline.length).toBeGreaterThan(0);
      expect(copy.primary.length).toBeGreaterThan(0);
      expect(copy.body).not.toContain("!");
      expect(copy.headline).not.toContain("!");
    }
    expect(coachCopy("doTheThing").secondary).toBe("Browse pools");
  });
});
