import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, decodeFunctionData, fallback, http, parseAbi, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis, mainnet } from 'viem/chains';
import { getOrder } from './db';

// Server-side, on-demand Safe deployment. The client calls /api/deploy the
// instant it sees the approval, so the order auto-deploys immediately instead of
// waiting for the polling relayer. Deployment is permissionless (ownership is
// fixed by the initializer), so this only saves the user the deploy gas/click.

// RPCs must serve BOTH eth_call (allowance/balance checks) and
// eth_sendRawTransaction. publicnode does both; oat/nodies are eth_call fallbacks.
const RPCS: Record<number, string[]> = {
  1: [process.env.MAINNET_RPC, 'https://ethereum-rpc.publicnode.com'].filter(Boolean) as string[],
  100: [process.env.GNOSIS_RPC, 'https://gnosis-rpc.publicnode.com', 'https://gnosis.oat.farm', 'https://gnosis-pokt.nodies.app'].filter(Boolean) as string[],
};
const CHAINS: Record<number, Chain> = { 1: mainnet, 100: gnosis };
const FACTORY = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2' as const;

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
const factoryAbi = parseAbi(['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)']);
const initAbi = parseAbi(['function initialize(address sellToken, address from, uint256 pullAmount, uint256 approveAmount, (address handler, bytes32 salt, bytes staticInput) params)']);
const setupAbi = parseAbi(['function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)']);

function relayerKey(): Hex {
  const pk = process.env.RELAYER_PK;
  if (pk) return (pk.startsWith('0x') ? pk : `0x${pk}`) as Hex;
  // dev fallback: the local deployer key (same one the standalone relayer uses)
  const j = JSON.parse(readFileSync(join(process.cwd(), '..', '.deployer', 'key.json'), 'utf8'));
  const k = j[0].private_key as string;
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
}

function requirement(initializer: Hex) {
  const s = decodeFunctionData({ abi: setupAbi, data: initializer });
  const init = decodeFunctionData({ abi: initAbi, data: s.args[3] as Hex });
  return { sellToken: init.args[0] as Hex, from: init.args[1] as Hex, pullAmount: init.args[2] as bigint };
}

// Don't submit the same Safe twice within this process; allow retry only when not-ready.
const claimed = new Set<string>();

export type DeployResult = { status: 'submitted' | 'already-deployed' | 'not-ready' | 'pending' | 'not-found' | 'error'; hash?: string; error?: string };

export async function triggerDeploy(safe: string): Promise<DeployResult> {
  const order = getOrder(safe);
  if (!order) return { status: 'not-found' };
  const key = safe.toLowerCase();
  if (claimed.has(key)) return { status: 'pending' };
  claimed.add(key);
  try {
    const chain = CHAINS[order.chainId];
    const rpcs = RPCS[order.chainId];
    if (!chain || !rpcs?.length) { claimed.delete(key); return { status: 'error', error: 'unsupported chain' }; }
    const transport = fallback(rpcs.map((u) => http(u, { timeout: 12_000 })));
    const pub = createPublicClient({ chain, transport });

    const code = await pub.getCode({ address: safe as Hex }).catch(() => undefined);
    if (code && code !== '0x') return { status: 'already-deployed' }; // keep claimed

    const req = requirement(order.initializer as Hex);
    if (req.pullAmount > 0n) {
      const [allowance, bal] = await Promise.all([
        pub.readContract({ address: req.sellToken, abi: erc20, functionName: 'allowance', args: [req.from, safe as Hex] }),
        pub.readContract({ address: req.sellToken, abi: erc20, functionName: 'balanceOf', args: [req.from] }),
      ]);
      if (allowance < req.pullAmount || bal < req.pullAmount) { claimed.delete(key); return { status: 'not-ready' }; }
    }

    const account = privateKeyToAccount(relayerKey());
    const wallet = createWalletClient({ account, chain, transport });
    const hash = await wallet.writeContract({
      address: FACTORY, abi: factoryAbi, functionName: 'createProxyWithNonce',
      args: [order.singleton as Hex, order.initializer as Hex, BigInt(order.saltNonce)],
    });
    return { status: 'submitted', hash }; // keep claimed so we never double-submit
  } catch (e) {
    claimed.delete(key);
    return { status: 'error', error: (e as Error)?.message?.slice(0, 200) };
  }
}
