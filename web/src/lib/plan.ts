import type { Address, Hex } from 'viem';
import type { ChainConfig } from './chains';
import { SAFE_1_3_0_PROXY_CREATION_CODE } from './__fixtures__/proxyCreationCode';
import { predictSafeAddress } from './predict';
import { buildBalanceDeployment, buildDeployment, type Deployment, type TwapData } from './twap';
import { APP_DATA_HASH } from './appData';

const MAX_UINT32 = 0xffffffffn;
const YEAR = 365n * 24n * 60n * 60n;

export type PlanInput = {
  owner: Address;
  chain: ChainConfig;
  sellToken: Address;
  sellDecimals: number;
  buyToken: Address;
  receiver?: Address; // defaults to the Safe
  totalSell: bigint; // total sellToken to actually sell (across the FUNDED parts)
  minPartLimit: bigint; // minimum buyToken received per part (from quote × (1−slippage))
  n: bigint; // number of FUNDED parts (K) — how much you sell
  partSeconds: bigint; // seconds per part (interval t)
  appData?: Hex;
  // --- canonical scheduling (all optional; defaults preserve old behavior) ---
  span?: bigint; // tradeable window within each interval; 0 = whole interval
  skipBufferBps?: number; // extra WINDOWS beyond funded parts, in bps (2000 = +20%)
  alignStart?: boolean; // snap t0 to the interval grid → canonical valid-froms
  nowSec?: bigint; // current unix time, used to floor t0 when alignStart
  // --- carrier-order flow ---
  salt?: Hex; // random bytes32 → unique conditional order + unique Safe address per TWAP
  carrierBufferBps?: number; // worst-case in-kind carrier shortfall reserved so every part funds (default 10)
};

export type Plan = {
  twap: TwapData;
  approveAmount: bigint; // == effectiveTotalSell (the FUNDED amount)
  effectiveTotalSell: bigint;
  partSellAmount: bigint;
  minPartLimit: bigint;
  fundedParts: bigint; // K — parts actually funded/sold
  windows: bigint; // n on-chain — total attempt windows (>= K when a skip buffer is set)
  aligned: boolean; // t0 snapped to the interval grid
  deployment: Deployment;
  safeAddress: Address;
  totalDuration: bigint; // windows × t (the full schedule, incl. buffer tail)
  carrierSellAmount: bigint; // the user's full input — what the carrier order sells (in-kind)
  carrierBuyMin: bigint; // guaranteed min delivered to the Safe (parts are sized to this)
  saltNonce: bigint; // proxy-factory saltNonce (0; uniqueness comes from the order salt)
  errors: string[];
};

/**
 * Build a fully-specified, deterministic TWAP deployment plan from form inputs.
 * Always returns a Plan (with `errors` populated when invalid) so the UI can
 * preview the address/summary even while inputs are incomplete.
 */
export function buildPlan(input: PlanInput): Plan {
  const errors: string[] = [];
  const K = input.n; // funded parts (how much you sell)
  const t = input.partSeconds;
  const span = input.span ?? 0n;

  if (K <= 1n) errors.push('Number of parts must be at least 2.');
  if (input.partSeconds <= 0n) errors.push('Interval must be greater than 0.');
  if (input.partSeconds > YEAR) errors.push('Interval must be at most 365 days.');
  if (span < 0n || span > t) errors.push('Trade window must be between 0 and the interval.');
  if (input.sellToken.toLowerCase() === input.buyToken.toLowerCase())
    errors.push('Sell and buy tokens must differ.');

  // Windows = funded parts + skip buffer. The TWAP exposes `partSellAmount` in
  // each of `windows` intervals, but funding only covers `K` fills — so the extra
  // windows are spare attempts that absorb intervals skipped on price. ceil().
  const bufferBps = BigInt(Math.max(0, Math.round(input.skipBufferBps ?? 0)));
  const safeK = K > 0n ? K : 1n;
  const windows = bigMax(safeK, (safeK * (10000n + bufferBps) + 9999n) / 10000n);
  if (windows > MAX_UINT32) errors.push('Too many parts.');

  // The in-kind carrier delivers >= buyMin to the Safe; sizing parts to buyMin (not the
  // signed totalSell) guarantees every part is funded — no stuck last part from the hop fee.
  const carrierBufferBps = BigInt(Math.max(0, Math.round(input.carrierBufferBps ?? 10)));
  const carrierBuyMin = (input.totalSell * (10000n - carrierBufferBps)) / 10000n;
  const partSellAmount = carrierBuyMin / safeK; // per-part size keyed to FUNDED parts
  const minPartLimit = input.minPartLimit;
  const effectiveTotalSell = partSellAmount * safeK; // funded amount (= K parts)

  if (partSellAmount <= 0n) errors.push('Sell amount per part must be greater than 0.');
  if (minPartLimit <= 0n) errors.push('Minimum receive per part must be greater than 0.');

  // Canonical valid-froms: snap t0 down to the interval grid (a multiple of t off
  // the Unix epoch), so every part's start lands on a wall-clock boundary in UTC.
  // 0 ⇒ "start now" (cabinet) at deploy time, as before.
  const aligned = !!input.alignStart && input.nowSec !== undefined && input.nowSec > 0n && t > 0n;
  // Balance-sizing arms with t0 == 0 ("start now" at deploy); grid-alignment is
  // not used (the start is the carrier-fill moment, unknown at sign time).
  const t0 = 0n;
  void aligned;

  // Zero-dust (balance-sizing) flow: the Safe is funded by the carrier fill and
  // deployed as a CoW post-interaction; the initializer splits the funded balance
  // into `windows` exact parts. The per-part amount is resolved on-chain, so only
  // the limit *rate* (minPartLimit per estimated part) is committed here.
  const receiver = input.receiver ?? input.owner;
  const salt = input.salt;
  if (!salt) errors.push('Missing salt (unique per TWAP).');
  if (!input.chain.twapBalanceInitializer) errors.push('Zero-dust TWAP not available on this chain.');

  const twap: TwapData = {
    sellToken: input.sellToken,
    buyToken: input.buyToken,
    receiver,
    partSellAmount, // estimate (bal/n); the on-chain value is resolved at deploy
    minPartLimit,
    t0,
    n: windows,
    t,
    span,
    appData: input.appData ?? APP_DATA_HASH,
  };

  // Provisional params/orderHash from the estimated part size (display only — the
  // real on-chain order hash is resolved post-fill from the delivered balance).
  const approveAmount = effectiveTotalSell;
  const provisional = buildDeployment({
    owner: input.owner,
    twap,
    approveAmount,
    from: input.owner,
    pullAmount: 0n,
    twapSafeInitializer: input.chain.twapSafeInitializer,
    extensibleFallbackHandler: input.chain.extensibleFallbackHandler,
    salt,
  });

  // The REAL initializer: balance-sizing setup. partSellAmount is NOT in it, so
  // it's not in the CREATE2 salt — the Safe address still commits to everything
  // known at sign time (tokens, n, t, span, limit rate, salt, appData).
  const balanceDep = buildBalanceDeployment({
    owner: input.owner,
    config: {
      sellToken: input.sellToken,
      buyToken: input.buyToken,
      receiver,
      n: windows,
      t,
      span,
      limitNum: minPartLimit, // minPartLimit per estimated part ...
      limitDen: partSellAmount > 0n ? partSellAmount : 1n, // ... / the estimated part size
      salt: salt ?? ('0x' + '0'.repeat(64)) as Hex,
      appData: input.appData ?? APP_DATA_HASH,
    },
    twapBalanceInitializer: input.chain.twapBalanceInitializer ?? input.chain.twapSafeInitializer,
    extensibleFallbackHandler: input.chain.extensibleFallbackHandler,
  });
  const deployment: Deployment = { ...provisional, initializer: balanceDep.initializer };

  const safeAddress = predictSafeAddress({
    factory: input.chain.safeProxyFactory,
    singleton: input.chain.safeSingleton,
    proxyCreationCode: SAFE_1_3_0_PROXY_CREATION_CODE,
    initializer: deployment.initializer,
    saltNonce: 0n,
  });

  return {
    twap,
    approveAmount,
    effectiveTotalSell,
    partSellAmount,
    minPartLimit,
    fundedParts: safeK,
    windows,
    aligned,
    deployment,
    safeAddress,
    totalDuration: t * windows,
    carrierSellAmount: input.totalSell,
    carrierBuyMin,
    saltNonce: 0n,
    errors,
  };
}

function bigMax(a: bigint, b: bigint): bigint { return a > b ? a : b; }
