// The binding ledger behind /api/unlink/authorization-token. Its whole job is
// to be the ONE record of which wallet owns which shielded address, written
// only by the authenticated register path — so the cases that matter are the
// ones where a second wallet tries to claim an address that is already taken.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { getAddress } from "viem";
import {
  bindWalletToUnlinkAddress,
  hasAuthenticatedBinding,
} from "@/lib/server/unlink-admin";

const DATA = path.join(process.cwd(), ".data");
const BINDINGS = path.join(DATA, "unlink-auth-bindings.json");

const OWNER = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const ATTACKER = getAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");

describe("authenticated Unlink binding ledger", () => {
  beforeEach(async () => {
    await fs.rm(BINDINGS, { force: true });
    vi.restoreAllMocks();
  });

  it("records a binding and reports it", async () => {
    await bindWalletToUnlinkAddress(OWNER, "unlink1owner");
    expect(await hasAuthenticatedBinding(OWNER, "unlink1owner")).toBe(true);
  });

  it("reports nothing before any registration", async () => {
    expect(await hasAuthenticatedBinding(OWNER, "unlink1owner")).toBe(false);
  });

  it("matches the wallet whatever case it is written in", async () => {
    await bindWalletToUnlinkAddress(OWNER, "unlink1owner");
    expect(
      await hasAuthenticatedBinding(
        OWNER.toLowerCase() as `0x${string}`,
        "unlink1owner",
      ),
    ).toBe(true);
  });

  it("does not authorize a different address for the same wallet", async () => {
    await bindWalletToUnlinkAddress(OWNER, "unlink1owner");
    expect(await hasAuthenticatedBinding(OWNER, "unlink1someoneelse")).toBe(
      false,
    );
  });

  it("does not authorize a different wallet for the same address", async () => {
    await bindWalletToUnlinkAddress(OWNER, "unlink1owner");
    expect(await hasAuthenticatedBinding(ATTACKER, "unlink1owner")).toBe(false);
  });

  it("refuses to move an address to a second wallet", async () => {
    // The takeover this ledger exists to stop: a wallet that never controlled
    // the account tries to register it and inherit its capability tokens.
    vi.spyOn(console, "error").mockImplementation(() => {});
    await bindWalletToUnlinkAddress(OWNER, "unlink1owner");

    await expect(
      bindWalletToUnlinkAddress(ATTACKER, "unlink1owner"),
    ).rejects.toThrow(/already bound/);

    expect(await hasAuthenticatedBinding(OWNER, "unlink1owner")).toBe(true);
    expect(await hasAuthenticatedBinding(ATTACKER, "unlink1owner")).toBe(false);
  });

  it("is idempotent for the same wallet and address", async () => {
    await bindWalletToUnlinkAddress(OWNER, "unlink1owner");
    await bindWalletToUnlinkAddress(OWNER, "unlink1owner");
    expect(await hasAuthenticatedBinding(OWNER, "unlink1owner")).toBe(true);
  });

  it("lets a wallet move to a new address and retires the old one", async () => {
    // A new appId derives a new Unlink account for the same wallet. The old
    // address must stop authorizing anyone, including its previous owner.
    await bindWalletToUnlinkAddress(OWNER, "unlink1old");
    await bindWalletToUnlinkAddress(OWNER, "unlink1new");

    expect(await hasAuthenticatedBinding(OWNER, "unlink1new")).toBe(true);
    expect(await hasAuthenticatedBinding(OWNER, "unlink1old")).toBe(false);

    // and the retired address is free again rather than permanently locked.
    await bindWalletToUnlinkAddress(ATTACKER, "unlink1old");
    expect(await hasAuthenticatedBinding(ATTACKER, "unlink1old")).toBe(true);
  });

  it("survives a stored file that predates the reverse index", async () => {
    await fs.mkdir(DATA, { recursive: true });
    await fs.writeFile(
      BINDINGS,
      JSON.stringify({ byWallet: { [OWNER.toLowerCase()]: "unlink1owner" } }),
      "utf8",
    );

    expect(await hasAuthenticatedBinding(OWNER, "unlink1owner")).toBe(true);
    await bindWalletToUnlinkAddress(OWNER, "unlink1owner");
    expect(await hasAuthenticatedBinding(OWNER, "unlink1owner")).toBe(true);
  });
});
