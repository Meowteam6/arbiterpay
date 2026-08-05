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
  // blockdaemon leads because it is the only endpoint that answers a browser
  // cleanly. rpc.testnet.arc.network sends no Access-Control-Allow-Origin, so
  // calling it from the app's origin fails CORS preflight and floods the
  // console on every pool page; it stays last because it is still a valid
  // server-side fallback (no CORS server-side) and it also rate-limits under
  // load. rpc.drpc.testnet.arc.network is dropped outright: it answers 400.
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
