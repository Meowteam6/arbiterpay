// GET /api/agent/wallet - SPOTTER's public identity card.
//
// The Circle credentials are server-only, so this route is the browser's
// window onto the agent's wallet: address, live USDC balance, and the
// block-explorer URL that Circle's proof 3 requires. Read-only; nothing here
// can move money.

import { getCircleClient, getSpotterWallet, getSpotterUsdcBalance } from "@/lib/server/agent/wallet";
import { arcAddressUrl } from "@/lib/chains";
import { errorMessage, jsonError } from "@/lib/server/http";

export async function GET() {
  try {
    const client = getCircleClient();
    const [wallet, balance] = await Promise.all([
      getSpotterWallet(client),
      getSpotterUsdcBalance(client),
    ]);
    return Response.json({
      address: wallet.address,
      blockchain: wallet.blockchain,
      balanceUsd: balance.amount,
      explorerUrl: arcAddressUrl(wallet.address),
    });
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
