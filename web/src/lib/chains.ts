import type { Address } from 'viem';
import { mainnet, gnosis } from 'wagmi/chains';

export type TokenInfo = {
  address: Address;
  symbol: string;
  decimals: number;
  name: string;
};

export type ChainConfig = {
  chainId: number;
  name: string;
  // Safe v1.3.0 canonical deployments
  safeProxyFactory: Address;
  safeSingleton: Address; // L1 on mainnet, SafeL2 on gnosis (Safe convention)
  extensibleFallbackHandler: Address;
  // CoW Protocol / ComposableCoW (identical across chains)
  composableCow: Address;
  twapHandler: Address;
  currentBlockTimestampFactory: Address;
  vaultRelayer: Address;
  // Our helper, deterministically deployed to the same address on every chain.
  twapSafeInitializer: Address;
  // Balance-sizing initializer: reads the Safe's funded balance at deploy and
  // splits it into n exact parts (zero dust). Used by the carrier post-hook flow.
  twapBalanceInitializer?: Address;
  // Carrier-order hook that CREATE2-deploys + arms the TWAP Safe as part of one
  // signed order (per-chain; absent until deployed -> carrier TWAP unavailable).
  twapBootstrap?: Address;
  // GPv2 settlement (prod) — the EIP-712 verifyingContract for carrier orders.
  cowSettlement: Address;
  // On-chain recovery registry (deterministic, same address every chain).
  twapDeploymentRegistry: Address;
  // UX
  explorer: string;
  cowExplorer: string;
  safeAppPrefix: string; // e.g. "eth" / "gno" for app.safe.global
  tokens: TokenInfo[];
};

// Same on all supported chains:
const COMPOSABLE_COW = '0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74' as const;
const TWAP_HANDLER = '0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5' as const;
const TS_FACTORY = '0x52eD56Da04309Aca4c3FECC595298d80C2f16BAc' as const;
const VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as const;
const SAFE_PROXY_FACTORY = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2' as const;
const EXT_FALLBACK_HANDLER = '0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5' as const;
const COW_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as const; // GPv2Settlement, same on every chain

// Deterministic address from contracts/script/DeployInitializer.s.sol (SALT v1,
// solc 0.8.34, optimizer 200, cancun). Same on every chain once deployed.
export const TWAP_SAFE_INITIALIZER = '0x3afA7DB0BEC365b4CF169A3556acDDe6653d0E18' as const;
export const TWAP_DEPLOYMENT_REGISTRY = '0xaCa53FB27DDc026A27f039CE98a500C3D6B9091a' as const;

export const CHAINS: Record<number, ChainConfig> = {
  [mainnet.id]: {
    chainId: mainnet.id,
    name: 'Ethereum',
    safeProxyFactory: SAFE_PROXY_FACTORY,
    safeSingleton: '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552', // Safe L1 v1.3.0
    extensibleFallbackHandler: EXT_FALLBACK_HANDLER,
    composableCow: COMPOSABLE_COW,
    twapHandler: TWAP_HANDLER,
    currentBlockTimestampFactory: TS_FACTORY,
    vaultRelayer: VAULT_RELAYER,
    twapSafeInitializer: TWAP_SAFE_INITIALIZER,
    twapDeploymentRegistry: TWAP_DEPLOYMENT_REGISTRY,
    cowSettlement: COW_SETTLEMENT,
    explorer: 'https://etherscan.io',
    cowExplorer: 'https://explorer.cow.fi',
    safeAppPrefix: 'eth',
    tokens: [
      { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
      { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
      { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6, name: 'Tether USD' },
      { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', decimals: 18, name: 'Dai Stablecoin' },
      { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', decimals: 8, name: 'Wrapped BTC' },
      { address: '0xae78736Cd615f374D3085123A210448E74Fc6393', symbol: 'rETH', decimals: 18, name: 'Rocket Pool ETH' },
      { address: '0xba100000625a3754423978a60c9317c58a424e3D', symbol: 'BAL', decimals: 18, name: 'Balancer' },
      { address: '0xDef1CA1fb7FBcDC777520aa7f396b4E015F497aB', symbol: 'COW', decimals: 18, name: 'CoW Protocol Token' },
    ],
  },
  [gnosis.id]: {
    chainId: gnosis.id,
    name: 'Gnosis Chain',
    safeProxyFactory: SAFE_PROXY_FACTORY,
    safeSingleton: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E', // SafeL2 v1.3.0
    extensibleFallbackHandler: EXT_FALLBACK_HANDLER,
    composableCow: COMPOSABLE_COW,
    twapHandler: TWAP_HANDLER,
    currentBlockTimestampFactory: TS_FACTORY,
    vaultRelayer: VAULT_RELAYER,
    twapSafeInitializer: TWAP_SAFE_INITIALIZER,
    twapDeploymentRegistry: TWAP_DEPLOYMENT_REGISTRY,
    cowSettlement: COW_SETTLEMENT,
    twapBootstrap: '0x2C1aB2AF546f9157628dA8F8b50b6f5Ec9f21422',
    twapBalanceInitializer: '0x415667181180052B3fad7Bdf65185Ac730Dce0EC',
    explorer: 'https://gnosisscan.io',
    cowExplorer: 'https://explorer.cow.fi/gc',
    safeAppPrefix: 'gno',
    tokens: [
      { address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', symbol: 'WXDAI', decimals: 18, name: 'Wrapped XDAI' },
      { address: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83', symbol: 'USDC', decimals: 6, name: 'USD//C on xDai' },
      { address: '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb', symbol: 'GNO', decimals: 18, name: 'Gnosis Token' },
      { address: '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1', symbol: 'WETH', decimals: 18, name: 'Wrapped Ether on Gnosis' },
      { address: '0x4ECaBa5870353805a9F068101A40E0f32ed605C6', symbol: 'USDT', decimals: 6, name: 'Tether on Gnosis' },
      { address: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430', symbol: 'EURe', decimals: 18, name: 'Monerium EUR emoney (v2)' },
    ],
  },
};

export const SUPPORTED_CHAINS = [mainnet, gnosis] as const;

export function getChainConfig(chainId: number | undefined): ChainConfig | undefined {
  if (chainId == null) return undefined;
  return CHAINS[chainId];
}
