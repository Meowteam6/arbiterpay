import { defineChain } from "viem";

/**
 * Arc testnet. Gas is paid in native USDC (18 decimals at the protocol
 * level); the canonical ERC-20 interface used for pool accounting lives at
 * 0x3600...0000 with 6 decimals.
 */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  // Order matters: viem's fallback transport tries these in sequence, so the
  // first entry is what a browser actually talks to on a healthy request.
  //
  // blockdaemon leads, but NOT for the reason originally recorded here. The
  // old comment claimed rpc.testnet.arc.network sends no
  // Access-Control-Allow-Origin and that rpc.drpc.testnet.arc.network answers
  // 400. Re-measured 2026-08-16 with fetch() from the production origin
  // (https://gohealthme-circle.vercel.app): all three answer 200 with the
  // correct chainId and no CORS failure, and rpc.testnet.arc.network was
  // actually the fastest of the three. Whatever was broken has been fixed
  // upstream.
  //
  // The order is kept as-is because it works and is deployed, not because the
  // other endpoints are broken. If you are here to "fix" an RPC problem,
  // measure from a browser origin first - curl ignores CORS, so a 200 from
  // the shell proves nothing either way.
  rpcUrls: {
    default: {
      http: [
        "https://rpc.blockdaemon.testnet.arc.network",
        "https://rpc.testnet.arc.network",
      ],
    },
  },
  blockExplorers: {
    default: {
      name: "Arcscan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

export function arcTxUrl(txHash: string): string {
  return `https://testnet.arcscan.app/tx/${txHash}`;
}

export function arcAddressUrl(address: string): string {
  return `https://testnet.arcscan.app/address/${address}`;
}
