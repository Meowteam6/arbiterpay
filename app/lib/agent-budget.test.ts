// "Out of budget" is a claim about money, so it may only be made from a
// balance the wallet route actually reported. An unknown balance is never
// broke, and a sub-cent balance always is: nothing priced can be bought with
// it, so no claim can be verified.

import { describe, it, expect } from "vitest";
import { agentIsBroke, parseAgentWallet } from "@/lib/agent-budget";

describe("parseAgentWallet", () => {
  it("reads the wallet route's shape", () => {
    expect(
      parseAgentWallet({
        address: "0xabc",
        balanceUsd: "2.994",
        explorerUrl: "https://explorer/0xabc",
        blockchain: "ARC-TESTNET",
      }),
    ).toEqual({
      address: "0xabc",
      balanceUsd: "2.994",
      explorerUrl: "https://explorer/0xabc",
    });
  });

  it("nulls every field it cannot trust rather than inventing one", () => {
    expect(parseAgentWallet(null)).toEqual({
      address: null,
      balanceUsd: null,
      explorerUrl: null,
    });
    expect(parseAgentWallet({ balanceUsd: 3 }).balanceUsd).toBeNull();
    expect(parseAgentWallet({ error: "not configured" }).balanceUsd).toBeNull();
  });
});

describe("agentIsBroke", () => {
  it("is false for an unknown balance", () => {
    expect(agentIsBroke(null)).toBe(false);
  });

  it("is true at zero and at sub-cent dust", () => {
    expect(agentIsBroke("0")).toBe(true);
    expect(agentIsBroke("0.00")).toBe(true);
    expect(agentIsBroke("0.004")).toBe(true);
  });

  it("is false for anything a priced step could actually buy", () => {
    expect(agentIsBroke("0.01")).toBe(false);
    expect(agentIsBroke("2.994")).toBe(false);
    expect(agentIsBroke("100")).toBe(false);
  });
});
