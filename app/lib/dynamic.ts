// Dynamic EvmNetwork descriptor for Arc testnet, passed via
// DynamicContextProvider overrides.evmNetworks.
// Shape verified against @dynamic-labs/types EvmNetwork (v4.88.6):
//   EvmNetwork = Omit<GenericNetwork, 'chainId'> & { chainId: number; ... }
//   GenericNetwork = Omit<NetworkConfiguration, 'chainId'|'networkId'|'shortName'|'chain'>
//                   & { chainId: number|string; networkId: number|string; ... }
// Required fields (all non-optional in NetworkConfiguration and not omitted):
//   name, nativeCurrency, rpcUrls, blockExplorerUrls, iconUrls, chainId, networkId
import type { EvmNetwork } from "@dynamic-labs/types";

export const arcEvmNetwork: EvmNetwork = {
  chainId: 5042002,
  networkId: 5042002,
  name: "Arc Testnet",
  iconUrls: [],
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  // Blockdaemon leads (matches lib/chains.ts). Dynamic writes these into the
  // external wallet via wallet_addEthereumChain, so an external-wallet user must
  // get the healthy endpoint, not the flaky rpc.testnet.arc.network alone, or
  // their transactions fail. Kept in sync with chains.ts on purpose.
  rpcUrls: [
    "https://rpc.blockdaemon.testnet.arc.network",
    "https://rpc.testnet.arc.network",
  ],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
};
