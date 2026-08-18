import { describe, it, expect } from "vitest";
import { spendMeterModel } from "@/lib/spend-meter";

describe("spendMeterModel", () => {
  it("is planning while no cap has landed", () => {
    expect(spendMeterModel("0.00", null)).toEqual({
      ratio: 0,
      atCap: false,
      planning: true,
    });
  });

  it("reports the fraction of the cap spent so far", () => {
    const m = spendMeterModel("0.25", "1.00");
    expect(m.ratio).toBeCloseTo(0.25, 5);
    expect(m.atCap).toBe(false);
    expect(m.planning).toBe(false);
  });

  it("clamps to the cap and never overstates spend past 100 percent", () => {
    const m = spendMeterModel("1.50", "1.00");
    expect(m.ratio).toBe(1);
    expect(m.atCap).toBe(true);
  });

  it("treats spend that exactly equals the cap as at-cap", () => {
    const m = spendMeterModel("1.00", "1.00");
    expect(m.ratio).toBe(1);
    expect(m.atCap).toBe(true);
  });

  it("parses cents from over-precise strings without floating drift", () => {
    // The ledger sometimes carries "0.410000"; cents truncation keeps it honest.
    const m = spendMeterModel("0.410000", "1.00");
    expect(m.ratio).toBeCloseTo(0.41, 5);
  });

  it("treats a zero cap as fully spent the moment any money moves", () => {
    expect(spendMeterModel("0.01", "0.00")).toEqual({
      ratio: 1,
      atCap: true,
      planning: false,
    });
    expect(spendMeterModel("0.00", "0.00")).toEqual({
      ratio: 0,
      atCap: false,
      planning: false,
    });
  });
});
