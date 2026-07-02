import { NextResponse } from 'next/server';
import { createPublicClient, http } from 'viem';
import { gnosis } from 'viem/chains';

export const runtime = 'nodejs';

// Current sDAI price-per-share + annualized rate, derived from the vault's own
// history (no rate getter exists on-chain). Cached — the rate barely moves.

const SDAI = '0xaf204776c7245bF4147c2612BF6e5972Ee483701' as const;
const RPC = process.env.NEXT_PUBLIC_GNOSIS_RPC || 'https://rpc.gnosischain.com';
const CONVERT_ABI = [{ type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ name: 's', type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as const;
const YEAR = 31_557_600; // seconds
const LOOKBACK_BLOCKS = 500_000n; // ~29 days on Gnosis (~5s blocks)

let cache: { pricePerShare: string; apy: number; ts: number } | null = null;
let cachedAt = 0;

export async function GET() {
  const now = Math.floor(Date.now() / 1000);
  if (cache && now - cachedAt < 1800) return NextResponse.json(cache); // 30 min cache

  const client = createPublicClient({ chain: gnosis, transport: http(RPC, { timeout: 20_000 }) });
  try {
    const head = await client.getBlockNumber();
    const past = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
    const [pNow, pPast, bNow, bPast] = await Promise.all([
      client.readContract({ address: SDAI, abi: CONVERT_ABI, functionName: 'convertToAssets', args: [10n ** 18n] }),
      client.readContract({ address: SDAI, abi: CONVERT_ABI, functionName: 'convertToAssets', args: [10n ** 18n], blockNumber: past }),
      client.getBlock({ blockNumber: head }),
      client.getBlock({ blockNumber: past }),
    ]);
    const dt = Number(bNow.timestamp - bPast.timestamp);
    const growth = Number(pNow) / Number(pPast);
    const apy = dt > 0 && growth > 1 ? growth ** (YEAR / dt) - 1 : 0.045;
    cache = { pricePerShare: (pNow as bigint).toString(), apy, ts: now };
    cachedAt = now;
    return NextResponse.json(cache);
  } catch (e) {
    // Fallback: current price only (via latest), sane APY.
    try {
      const pNow = await client.readContract({ address: SDAI, abi: CONVERT_ABI, functionName: 'convertToAssets', args: [10n ** 18n] });
      return NextResponse.json({ pricePerShare: (pNow as bigint).toString(), apy: 0.045, ts: now });
    } catch {
      return NextResponse.json({ error: (e as Error).message }, { status: 502 });
    }
  }
}
