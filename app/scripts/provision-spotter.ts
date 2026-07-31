// One-time provisioning for SPOTTER's Circle wallet on Arc testnet.
//
// Run from app/ (loads repo-root .env then app/.env.local):
//   npm run agent:provision
//
// Requires CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET (Circle developer console).
// Prints the env lines to paste back into .env and app/.env.local. Refuses to
// run when CIRCLE_WALLET_ID is already set, because provisioning twice
// strands the funded wallet; override with FORCE_REPROVISION=1.

import {
  getCircleClient,
  provisionSpotterWallet,
  fundSpotterFromFaucet,
} from "../lib/server/agent/wallet";

const EXPLORER_BASE = "https://testnet.arcscan.app/address/";

async function main(): Promise<void> {
  const existing = process.env.CIRCLE_WALLET_ID?.trim();
  if (existing && process.env.FORCE_REPROVISION !== "1") {
    console.error(
      `CIRCLE_WALLET_ID is already set (${existing}). SPOTTER is provisioned; ` +
        "a second run would strand that wallet and its funds. " +
        "Set FORCE_REPROVISION=1 only if you mean it.",
    );
    process.exit(1);
  }

  const client = getCircleClient();
  const spotter = await provisionSpotterWallet(client);

  console.log("SPOTTER provisioned on", spotter.blockchain);
  console.log("  wallet set:", spotter.walletSetId);
  console.log("  wallet id: ", spotter.walletId);
  console.log("  address:   ", spotter.address);
  console.log("  explorer:  ", EXPLORER_BASE + spotter.address);

  try {
    await fundSpotterFromFaucet(client, spotter.address);
    console.log("Faucet request accepted; USDC lands in about a minute.");
  } catch (error) {
    console.error(
      "Faucet request failed - fund manually at https://faucet.circle.com:",
      error instanceof Error ? error.message : error,
    );
  }

  console.log("\nPaste into .env AND app/.env.local:");
  console.log(`CIRCLE_WALLET_SET_ID=${spotter.walletSetId}`);
  console.log(`CIRCLE_WALLET_ID=${spotter.walletId}`);
  console.log(`SPOTTER_WALLET_ADDRESS=${spotter.address}`);
  console.log(
    "\nNext: make SPOTTER the oracle and settler once the agent run loop " +
      "exists - scripts/set-agent-oracle.sh " +
      spotter.address,
  );
}

main().catch((error) => {
  console.error("Provisioning failed:", error);
  process.exit(1);
});
