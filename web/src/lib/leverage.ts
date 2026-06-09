import { type Address, type Hex, concatHex, encodeFunctionData, hashTypedData, keccak256, numberToHex, stringToHex, getAddress, parseAbi } from 'viem';
import LevLong from './LevLong.json';
import { predictSafeAddress } from './predict';
import { SAFE_1_3_0_PROXY_CREATION_CODE } from './__fixtures__/proxyCreationCode';

export const levLongAbi = LevLong.abi;
export const levLongBytecode = LevLong.bytecode as Hex;

// --- Real-Safe position architecture (Gnosis) ---
export const SAFE = {
  factory: getAddress('0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2'),
  singleton: getAddress('0x3E5c63644E683549055b9Be8653de26E0B4CD36E'), // SafeL2 v1.3.0
  levModule: getAddress('0x1641c5Ab962e1bEA8806d3A0546987d825eF41Ff'), // v4: Safe-bound EIP-1271 (replay-safe) + owner-only close (no fund-exfil) + open/increase/reduce/close
  levModuleV2: getAddress('0x6671295869cAD640F5fA20FC1c1f0A1B386Fb7F3'), // v2: raw-digest EIP-1271 (legacy positions only — raw signing)
  levSafeInit: getAddress('0x53A77329A544d235d569D62941303cAbeF536Df0'), // setup helper
} as const;

/** EIP-712 SafeMessage typed-data the owner signs to authorize an order, bound to THIS Safe
 *  (domain.verifyingContract = safe). LevModule v3's isValidSignature only accepts this form,
 *  so the signature can't be replayed as a plain EOA order or against another Safe. */
export function safeMessageTypedData(safe: Address, orderDigest: Hex) {
  return {
    domain: { chainId: 100, verifyingContract: getAddress(safe) },
    types: { SafeMessage: [{ name: 'message', type: 'bytes32' }] },
    primaryType: 'SafeMessage' as const,
    message: { message: orderDigest },
  };
}

// LevModule's hook/borrower selectors (the position Safe answers these via fallback).
export const levModuleAbi = parseAbi([
  'function openLeg(address collateral, address debtToken, uint256 borrowAmount, uint256 repayApprove)',
  'function reducePrepare(address collateral, address debtToken, uint256 repayAmount, uint256 withdrawAmount)',
  'function closeFinalize(address collateral, address debtToken, uint256 repayApprove)',
]);

const safeSetupAbi = parseAbi(['function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)']);
const levInitAbi = parseAbi(['function setup(address module, address sellToken, address relayer)']);

/** Safe.setup initializer: owner = user, fallback handler = LevModule, and a delegatecall to
 *  LevSafeInit to enable the module + approve the relayer for the sell token. */
export function buildSafeInitializer(owner: Address, sellToken: Address): Hex {
  const initData = encodeFunctionData({ abi: levInitAbi, functionName: 'setup', args: [SAFE.levModule, getAddress(sellToken), GNOSIS.relayer] });
  return encodeFunctionData({ abi: safeSetupAbi, functionName: 'setup', args: [[getAddress(owner)], 1n, SAFE.levSafeInit, initData, SAFE.levModule, '0x0000000000000000000000000000000000000000', 0n, '0x0000000000000000000000000000000000000000'] });
}

/** Deterministic position-Safe address for a given initializer + saltNonce. */
export function predictPositionSafe(initializer: Hex, saltNonce: bigint): Address {
  return predictSafeAddress({ factory: SAFE.factory, singleton: SAFE.singleton, proxyCreationCode: SAFE_1_3_0_PROXY_CREATION_CODE, initializer, saltNonce });
}

// --- Gnosis addresses (all verified working in the live atomic-leverage test) ---
export const GNOSIS = {
  settlement: getAddress('0x9008d19f58aabd9ed0d60971565aa8510560ab41'),
  relayer: getAddress('0xc92e8bdf79f0507f65a392b0ab4667716bfe0110'),
  aavePool: getAddress('0xb50201558b00496a145fe76f7424749556e326d8'),
  flashRouter: getAddress('0x9da8b48441583a2b93e2ef8213aad0ec0b392c69'),
  trampoline: getAddress('0x60bf78233f48ec42ee3f101b9a05ec7878728006'),
} as const;

export const FLASHLOAN_PREMIUM_BPS = 5n; // Aave Gnosis FLASHLOAN_PREMIUM_TOTAL = 0.05%

export type LevToken = { address: Address; symbol: string; decimals: number };

// Curated Gnosis Aave tokens for v1. debt = the stable you borrow (and flash-borrow);
// collateral = the asset you go long. ltv/liqThreshold are the on-chain Aave values.
export const LEV_DEBT_TOKENS: LevToken[] = [
  { address: getAddress('0xe91d153e0b41518a2ce8dd3d7944fa863463a97d'), symbol: 'WXDAI', decimals: 18 },
  { address: getAddress('0x2a22f9c3b484c3629090feed35f17ff8f88f76f0'), symbol: 'USDC.e', decimals: 6 },
];
export const LEV_COLLATERAL_TOKENS: (LevToken & { liqThresholdBps: number })[] = [
  { address: getAddress('0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1'), symbol: 'WETH', decimals: 18, liqThresholdBps: 8300 },
  { address: getAddress('0x6c76971f98945ae98dd7d4dfca8711ebea946ea6'), symbol: 'wstETH', decimals: 18, liqThresholdBps: 7900 },
];

/**
 * Position economics for X× long with `equity` units of the debt token.
 *  - loan (= sellAmount): flash-borrow X·equity, sell all of it for collateral
 *  - after the sell, exactly `equity` of debt token remains in the instance
 *  - borrow exactly enough to repay loan+premium: borrow = loan + premium − equity
 *    → at repayment the instance holds `equity + borrow == loan + premium`, the exact
 *      amount Aave pulls, so NOTHING is left over (premium uses the same integer
 *      formula Aave applies, so it matches to the wei).
 *  - resulting position ≈ collateral worth X·equity, debt ≈ (X−1)·equity + flash-loan fee
 */
export function computeAmounts(equity: bigint, leverageX: number) {
  const xNum = BigInt(Math.round(leverageX * 1000));
  const loan = (equity * xNum) / 1000n;
  // Match Aave's PercentageMath.percentMul EXACTLY (rounds half-up): premium =
  // (loan*5 + 5000) / 10000. Using floor here could leave the borrow 1 wei short
  // of what Aave pulls and make the settlement revert.
  const premium = (loan * FLASHLOAN_PREMIUM_BPS + 5000n) / 10000n;
  const repay = loan + premium;
  const borrow = repay > equity ? repay - equity : 0n;
  const repayApprove = repay; // approve exactly what Aave pulls → zero dust
  return { loan, premium, borrow, repayApprove };
}

const ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' }, { name: 'buyAmount', type: 'uint256' }, { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' }, { name: 'feeAmount', type: 'uint256' }, { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' }, { name: 'sellTokenBalance', type: 'string' }, { name: 'buyTokenBalance', type: 'string' },
  ],
} as const;

export const GPV2_DOMAIN = { name: 'Gnosis Protocol', version: 'v2', chainId: 100, verifyingContract: GNOSIS.settlement } as const;

export type BuiltOrder = {
  appDataDoc: string;
  appDataHash: Hex;
  digest: Hex;
  uid: Hex;
  orderBody: Record<string, unknown>;
  typedData: { domain: typeof GPV2_DOMAIN; types: typeof ORDER_TYPES; primaryType: 'Order'; message: Record<string, unknown> };
};

function assemble(safe: Address, appDataDoc: string, msg: {
  sellToken: Address; buyToken: Address; sellAmount: bigint; buyAmount: bigint; validTo: number; kind: 'sell' | 'buy';
}): BuiltOrder {
  const appDataHash = keccak256(stringToHex(appDataDoc));
  const message = {
    sellToken: msg.sellToken, buyToken: msg.buyToken, receiver: safe, sellAmount: msg.sellAmount, buyAmount: msg.buyAmount,
    validTo: msg.validTo, appData: appDataHash, feeAmount: 0n, kind: msg.kind, partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
  };
  const digest = hashTypedData({ domain: GPV2_DOMAIN, types: ORDER_TYPES, primaryType: 'Order', message });
  const uid = concatHex([digest, safe, numberToHex(msg.validTo, { size: 4 })]);
  const orderBody = {
    sellToken: msg.sellToken, buyToken: msg.buyToken, receiver: safe, sellAmount: msg.sellAmount.toString(), buyAmount: msg.buyAmount.toString(),
    validTo: msg.validTo, appData: appDataDoc, appDataHash, feeAmount: '0', kind: msg.kind, partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
    signingScheme: 'eip1271', signature: '0x', from: safe,
  };
  return { appDataDoc, appDataHash, digest, uid, orderBody, typedData: { domain: GPV2_DOMAIN, types: ORDER_TYPES, primaryType: 'Order', message } };
}

/** OPEN: flash-borrow debt token, sell it for collateral, supply + borrow (post-hook openLeg). */
export function buildLeverageOrder(p: {
  safe: Address; debtToken: Address; collateral: Address; loan: bigint; buyAmountMin: bigint; borrow: bigint; repayApprove: bigint; validTo: number;
}): BuiltOrder {
  const safe = getAddress(p.safe), sell = getAddress(p.debtToken), buy = getAddress(p.collateral);
  const openLegCalldata = encodeFunctionData({ abi: levModuleAbi, functionName: 'openLeg', args: [buy, sell, p.borrow, p.repayApprove] });
  const appDataDoc = JSON.stringify({
    appCode: 'CoW Leverage',
    metadata: {
      flashloan: { amount: p.loan.toString(), liquidityProvider: GNOSIS.aavePool, protocolAdapter: safe, receiver: safe, token: sell },
      hooks: { version: '0.1.0', post: [{ target: safe, callData: openLegCalldata, gasLimit: '1200000' }] },
    },
    version: '1.14.0',
  });
  return assemble(safe, appDataDoc, { sellToken: sell, buyToken: buy, sellAmount: p.loan, buyAmount: p.buyAmountMin, validTo: p.validTo, kind: 'sell' });
}

/** LEVER-DOWN order (reduce / decrease / close). Flash-borrow debt, repay `repayAmount` +
 *  withdraw `withdrawAmount` (pre-hook reducePrepare), swap collateral, repay loan + forward the
 *  freed equity to recipient (post-hook closeFinalize). Use max amounts for a full close, a fraction
 *  for a partial reduce, or an equity-preserving Δ for a leverage decrease.
 *  payout 'debt' = sell `sellCollateral` for the debt token (cash out); 'collateral' = buy back exactly
 *  loan+premium of debt and keep the rest as collateral. */
export function buildReduceOrder(p: {
  safe: Address; collateral: Address; debtToken: Address;
  repayAmount: bigint; withdrawAmount: bigint; sellCollateral: bigint;
  loan: bigint; premium: bigint; repayApprove: bigint;
  validTo: number; payout: 'debt' | 'collateral'; quoteOut: bigint;
}): BuiltOrder {
  const safe = getAddress(p.safe), coll = getAddress(p.collateral), debt = getAddress(p.debtToken);
  const pre = encodeFunctionData({ abi: levModuleAbi, functionName: 'reducePrepare', args: [coll, debt, p.repayAmount, p.withdrawAmount] });
  // closeFinalize forwards the freed equity to the Safe OWNER on-chain (no recipient arg → no exfil vector)
  const post = encodeFunctionData({ abi: levModuleAbi, functionName: 'closeFinalize', args: [coll, debt, p.repayApprove] });
  const appDataDoc = JSON.stringify({
    appCode: 'CoW Leverage',
    metadata: {
      flashloan: { amount: p.loan.toString(), liquidityProvider: GNOSIS.aavePool, protocolAdapter: safe, receiver: safe, token: debt },
      hooks: { version: '0.1.0', pre: [{ target: safe, callData: pre, gasLimit: '900000' }], post: [{ target: safe, callData: post, gasLimit: '500000' }] },
    },
    version: '1.14.0',
  });
  if (p.payout === 'collateral') {
    // BUY exactly (loan + premium) debt token; sell up to `sellCollateral`; keep the rest as collateral.
    return assemble(safe, appDataDoc, { sellToken: coll, buyToken: debt, sellAmount: p.sellCollateral, buyAmount: p.loan + p.premium, validTo: p.validTo, kind: 'buy' });
  }
  // SELL `sellCollateral` for the debt token (cash out). 3% slippage cap (thin solver surplus on small flash-loan closes).
  return assemble(safe, appDataDoc, { sellToken: coll, buyToken: debt, sellAmount: p.sellCollateral, buyAmount: (p.quoteOut * 97n) / 100n, validTo: p.validTo, kind: 'sell' });
}

const MAX = (2n ** 256n) - 1n;
const premiumOf = (loan: bigint) => (loan * FLASHLOAN_PREMIUM_BPS + 5000n) / 10000n;

/** INCREASE leverage L→L' (equity-preserving): flash-borrow Δdebt = equityValue·(L'−L), buy that much
 *  collateral, supply it and borrow Δdebt+premium to repay the loan. No new equity needed. */
export function computeIncrease(p: { equityValueDebt: bigint; currentLevX1000: bigint; targetLevX1000: bigint; price: number; collDecimals: number; debtDecimals: number }) {
  const loan = (p.equityValueDebt * (p.targetLevX1000 - p.currentLevX1000)) / 1000n;
  const premium = premiumOf(loan);
  const borrow = loan + premium;
  // expected collateral out (qty) = loan(debt) / price, in collateral decimals, with 1% slippage floor
  const collOut = (Number(loan) / 10 ** p.debtDecimals / p.price) * (1 - 0.01);
  const buyAmountMin = BigInt(Math.floor(collOut * 10 ** p.collDecimals));
  return { loan, premium, borrow, repayApprove: loan + premium, buyAmountMin };
}

/** REDUCE by fraction (cash out) OR full close (fraction=1). Repays f·debt, withdraws f·collateral,
 *  sells it for the chosen token; the freed equity (≈ f·equity) goes to the user. */
export function computeReduce(p: { collateralQty: bigint; debtQty: bigint; fractionBps: bigint }) {
  const repayAmount = p.fractionBps >= 10000n ? MAX : (p.debtQty * p.fractionBps) / 10000n;
  const withdrawAmount = p.fractionBps >= 10000n ? MAX : (p.collateralQty * p.fractionBps) / 10000n;
  const sellCollateral = (p.collateralQty * p.fractionBps) / 10000n; // actual collateral sold by the order
  const repayDebt = (p.debtQty * p.fractionBps) / 10000n;            // debt actually repaid
  const loan = repayDebt + repayDebt / 100n + 1n;                    // +1% interest/safety buffer
  const premium = premiumOf(loan);
  return { repayAmount, withdrawAmount, sellCollateral, loan, premium, repayApprove: loan + premium };
}

export type PositionMetrics = {
  collateralUsd: number; debtUsd: number; equityUsd: number; leverage: number;
  healthFactor: number; liqThresholdBps: number; liqPrice: number | null; dropToLiqPct: number | null;
};
/** Derive display metrics from Aave getUserAccountData + the collateral qty/price.
 *  base values are USD 1e8 (Aave), hf is 1e18, collateralQty is human (formatted) collateral. */
export function positionMetrics(p: {
  collateralBase: bigint; debtBase: bigint; liqThresholdBps: number; healthFactor1e18: bigint;
  collateralQty: number; collateralPriceUsd: number;
}): PositionMetrics {
  const collateralUsd = Number(p.collateralBase) / 1e8;
  const debtUsd = Number(p.debtBase) / 1e8;
  const equityUsd = collateralUsd - debtUsd;
  const leverage = equityUsd > 0 ? collateralUsd / equityUsd : 0;
  const lt = p.liqThresholdBps / 10000;
  // liquidation when collateralQty * price * LT == debt  →  liqPrice = debt / (LT * collateralQty)
  const liqPrice = p.collateralQty > 0 && lt > 0 && debtUsd > 0 ? debtUsd / (lt * p.collateralQty) : null;
  const dropToLiqPct = liqPrice != null && p.collateralPriceUsd > 0 ? ((p.collateralPriceUsd - liqPrice) / p.collateralPriceUsd) * 100 : null;
  return { collateralUsd, debtUsd, equityUsd, leverage, healthFactor: Number(p.healthFactor1e18) / 1e18, liqThresholdBps: p.liqThresholdBps, liqPrice, dropToLiqPct };
}

/** DECREASE leverage L→L' (equity-preserving): sell Δcollateral to repay Δdebt, keep the position open.
 *  Δdebt = equityValue·(L−L'); withdraw a hair more collateral to cover the flash-loan premium. */
export function computeDecrease(p: { equityValueDebt: bigint; currentLevX1000: bigint; targetLevX1000: bigint; price: number; collDecimals: number; debtDecimals: number }) {
  const deltaDebt = (p.equityValueDebt * (p.currentLevX1000 - p.targetLevX1000)) / 1000n;
  const loan = deltaDebt + 1n;
  const premium = premiumOf(loan);
  const repayAmount = deltaDebt;
  // collateral to withdraw+sell = (deltaDebt + premium) worth, +1.5% so the sale covers the loan repay
  const sellValueDebt = Number(loan + premium) / 10 ** p.debtDecimals;
  const collQty = (sellValueDebt / p.price) * 1.015;
  const withdrawAmount = BigInt(Math.floor(collQty * 10 ** p.collDecimals));
  return { repayAmount, withdrawAmount, sellCollateral: withdrawAmount, loan, premium, repayApprove: loan + premium };
}
