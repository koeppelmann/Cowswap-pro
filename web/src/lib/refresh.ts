import 'server-only';
import { createPublicClient, fallback, http, parseAbi, type Chain } from 'viem';
import { gnosis, mainnet } from 'viem/chains';
import { listOrders, updateStatusMany, type OrderRow, type OrderStatusJSON } from './db';
import { cowBase } from './cowApiBase';

// Background enrichment so /orders is a pure DB read on the request path.
//
// One `eth_call` to TwapOrderLens.check(...) gets {deployed, active, allowance,
// safeBalance} for EVERY order at once. For the DEPLOYED ones (a handful) we then
// fetch CoW trades to get the REAL fill count + executed amounts — the Safe's
// balance can't tell "sold" from "withdrawn", so we can't infer fills from it.
// All in the background; the request path stays a DB read. Per-leg detail is
// still fetched lazily when a row is expanded.
//
// NOTE: many free Gnosis RPCs (drpc, publicnode) DON'T support eth_call for this
// batch — only the endpoints below reliably do. Override with GNOSIS_RPC.

const RPCS: Record<number, string[]> = {
  1: [process.env.MAINNET_RPC, 'https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'].filter(Boolean) as string[],
  100: [
    process.env.GNOSIS_RPC,
    'https://gnosis.oat.farm',
    'https://gnosis-pokt.nodies.app',
    'https://gnosis.api.onfinality.io/public',
    'https://rpc.gnosischain.com',
  ].filter(Boolean) as string[],
};
const CHAINS: Record<number, Chain> = { 1: mainnet, 100: gnosis };
const COW_NET: Record<number, string> = { 1: 'mainnet', 100: 'xdai' };

// TwapOrderLens — deployed deterministically on both chains.
const LENS = '0xd1a12ba577A161a486EE53FA62C5b8Ccf14Fd963' as const;
const lensAbi = parseAbi([
  'struct State { bool deployed; bool active; uint256 allowance; uint256 safeBalance; }',
  'function check(address[] safes, address[] owners, address[] sellTokens, bytes32[] orderHashes) view returns (State[])',
]);

const inFlight = new Set<string>();
const lastRun = new Map<string, number>();
const STALE_MS = 20_000;

function client(chainId: number) {
  return createPublicClient({
    chain: CHAINS[chainId],
    transport: fallback(RPCS[chainId].map((u) => http(u, { timeout: 12_000, retryCount: 1 }))),
  });
}

// null = fetch failed (keep the balance estimate); [] = a real "no fills yet".
async function tradesFor(chainId: number, safe: string): Promise<Array<{ sellAmount: string; buyAmount: string }> | null> {
  try {
    const { url, headers } = cowBase(COW_NET[chainId]);
    const r = await fetch(`${url}/api/v1/trades?owner=${safe}`, { cache: 'no-store', headers });
    if (!r.ok) return null;
    return (await r.json()) as Array<{ sellAmount: string; buyAmount: string }>;
  } catch { return null; }
}


type LensState = { deployed: boolean; active: boolean; allowance: bigint; safeBalance: bigint };

/** Estimate filled parts from how much sellToken is left in the safe. */
function partsFromBalance(o: OrderRow, safeBalance: bigint): number {
  const total = BigInt(o.totalSell);
  const part = BigInt(o.partSell);
  if (part <= 0n) return 0;
  const sold = total > safeBalance ? total - safeBalance : 0n;
  const p = Number(sold / part);
  return Math.max(0, Math.min(o.n, p));
}

/** Fire-and-forget: refresh ALL of the owner's orders into the DB if stale. */
export function refreshOwnerIfStale(chainId: number, owner: string, _limit?: number): void {
  const key = `${chainId}:${owner.toLowerCase()}`;
  if (inFlight.has(key)) return;
  if ((Date.now() - (lastRun.get(key) ?? 0)) < STALE_MS) return;
  inFlight.add(key);
  (async () => {
    try {
      const rows = listOrders(chainId, owner);
      if (rows.length === 0) return;
      const c = client(chainId);

      // 1) One eth_call for the on-chain state of every order.
      let states: readonly LensState[];
      try {
        states = (await c.readContract({
          address: LENS,
          abi: lensAbi,
          functionName: 'check',
          args: [
            rows.map((r) => r.safe as `0x${string}`),
            rows.map((r) => r.owner as `0x${string}`),
            rows.map((r) => r.sellToken as `0x${string}`),
            rows.map((r) => r.orderHash as `0x${string}`),
          ],
        })) as readonly LensState[];
      } catch (e) {
        console.error('[refresh] lens call failed', (e as Error)?.message);
        return;
      }

      // 2) Base statuses from the lens; balance-derived fill estimate as fallback.
      const updates: Array<{ safe: string; status: OrderStatusJSON }> = [];
      const deployedIdx: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        const s = states[i];
        if (s.deployed) deployedIdx.push(i);
        updates.push({
          safe: rows[i].safe,
          status: {
            deployed: s.deployed,
            active: s.active,
            allowance: s.allowance.toString(),
            filledParts: s.deployed ? partsFromBalance(rows[i], s.safeBalance) : 0,
            executedSell: '0',
            executedBuy: '0',
            remainingSell: s.deployed ? s.safeBalance.toString() : '0',
            startTime: 0,
          },
        });
      }

      // 3) Real fills for deployed orders (the balance can't distinguish
      // sold-vs-withdrawn). Throttled; failures keep the balance estimate.
      const CONC = 4;
      for (let i = 0; i < deployedIdx.length; i += CONC) {
        await Promise.all(deployedIdx.slice(i, i + CONC).map(async (idx) => {
          const tr = await tradesFor(chainId, rows[idx].safe);
          if (tr === null) return; // fetch failed — keep balance estimate
          let execSell = 0n, execBuy = 0n;
          for (const t of tr) { execSell += BigInt(t.sellAmount); execBuy += BigInt(t.buyAmount); }
          const u = updates[idx].status;
          u.filledParts = tr.length; // REAL fill count
          u.executedSell = execSell.toString();
          u.executedBuy = execBuy.toString();
        }));
      }

      updateStatusMany(updates);
    } finally {
      lastRun.set(key, Date.now());
      inFlight.delete(key);
    }
  })();
}
