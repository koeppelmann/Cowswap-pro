import {
  type Address,
  type Hex,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  toHex,
  zeroAddress,
} from 'viem';
import { predictSafeAddress } from './predict';
import { encodeSafeSetup } from './twap';
import { GPV2_ORDER_TYPES } from './carrier';
import { safeProxyFactoryAbi } from './abi';
import { SAFE_1_3_0_PROXY_CREATION_CODE } from './__fixtures__/proxyCreationCode';

/**
 * "Swap → sDAI on Gnosis" glue.
 *
 * Forward flow (mainnet token X → sDAI on Gnosis):
 *   1. A CoW order sells token X for USDS with `receiver` = a counterfactual 1/1
 *      Safe(user) on mainnet. The order's appData carries a POST-hook that
 *      permissionlessly deploys that Safe via SafeProxyFactory.createProxyWithNonce.
 *   2. The Safe's setup() delegatecalls BridgeInitializer, which bridges the whole
 *      USDS balance as native xDAI to a per-user Gnosis Safe (via the xDAI bridge).
 *   3. After ~26 min anyone calls ConvertModule.convert(gnosisSafe): xDAI → sDAI
 *      to the user, minus a 0.01 xDAI keeper tip.
 *
 * Determinism: the Gnosis Safe is per-USER (saltNonce 0) — reused across transfers,
 * since convert() is repeatable and only needs the address. The mainnet Safe is
 * per-TRANSFER (random saltNonce) — its bridge trigger is one-shot at deploy, so a
 * fresh Safe is required each time.
 */

// ---- mainnet ----
export const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F' as const; // Sky USDS (bridged token)
export const FOREIGN_BRIDGE = '0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016' as const;
export const MAINNET_SINGLETON = '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552' as const; // Safe L1 v1.3.0

// ---- gnosis ----
export const SDAI = '0xaf204776c7245bF4147c2612BF6e5972Ee483701' as const; // sDAI (ERC-4626 / SavingsXDai)
export const SAVINGS_ADAPTER = '0xD499b51fcFc66bd31248ef4b28d656d67E591A94' as const;
export const HOME_BRIDGE = '0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6' as const;
export const GNOSIS_SINGLETON = '0x3E5c63644E683549055b9Be8653de26E0B4CD36E' as const; // SafeL2 v1.3.0

// ---- shared Safe infra (same address on every chain) ----
export const SAFE_PROXY_FACTORY = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2' as const;

// ---- our deployed contracts (deterministic CREATE2; see contracts/script/DeploySdaiBridge.s.sol) ----
export const BRIDGE_INITIALIZER = '0xb6d3B979bEba11df263f993269E3694a39873918' as const; // mainnet
export const CONVERT_MODULE = '0x7cE6e4fe5c6658FF3f98C417Da09E6C31c9aAae3' as const; // gnosis
export const SDAI_SAFE_INITIALIZER = '0x763F685cF83FA18EFeB87c79b50ca733B373C701' as const; // gnosis
export const RETURN_ROUTER = '0xAb99F0C38194766ee435306Fc36bc6c4f6ce2D02' as const; // gnosis

// Home xDAI bridge minimum per transfer (verified on-chain): 10 xDAI.
export const REVERSE_MIN_XDAI = 10n * 10n ** 18n;

const GPV2_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as const;

const initAbi = [
  { type: 'function', name: 'initialize', stateMutability: 'nonpayable', inputs: [{ name: 'a', type: 'address' }], outputs: [] },
] as const;

const returnRouterAbi = [
  { type: 'function', name: 'returnToMainnet', stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' }, { name: 'mainnetRecipient', type: 'address' },
      { name: 'deadline', type: 'uint256' }, { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
    ], outputs: [] },
] as const;

/** Safe.setup() calldata (the proxy initializer) for the per-user Gnosis Safe that
 *  enables ConvertModule. Depends only on `owner`, so it is derivable by anyone. */
export function gnosisSafeSetup(owner: Address): Hex {
  const data = encodeFunctionData({ abi: initAbi, functionName: 'initialize', args: [CONVERT_MODULE] });
  return encodeSafeSetup({ owner, to: SDAI_SAFE_INITIALIZER, data, fallbackHandler: zeroAddress });
}

/** The user's deterministic Gnosis Safe. Per-TRANSFER (unique saltNonce) so each
 *  deposit maps to its own Safe — a reused Safe conflates concurrent transfers in
 *  the finalizer's book-keeping. `convert` sends the sDAI to the owner either way. */
export function predictGnosisSafe(owner: Address, saltNonce: bigint): Address {
  return predictSafeAddress({
    factory: SAFE_PROXY_FACTORY,
    singleton: GNOSIS_SINGLETON,
    proxyCreationCode: SAFE_1_3_0_PROXY_CREATION_CODE,
    initializer: gnosisSafeSetup(owner),
    saltNonce,
  });
}

/** Safe.setup() calldata for a mainnet Safe that bridges USDS to `gnosisReceiver`. */
export function mainnetSafeSetup(owner: Address, gnosisReceiver: Address): Hex {
  const data = encodeFunctionData({ abi: initAbi, functionName: 'initialize', args: [gnosisReceiver] });
  return encodeSafeSetup({ owner, to: BRIDGE_INITIALIZER, data, fallbackHandler: zeroAddress });
}

/** The per-transfer mainnet Safe address for a given (owner, gnosisReceiver, saltNonce). */
export function predictMainnetSafe(owner: Address, gnosisReceiver: Address, saltNonce: bigint): Address {
  return predictSafeAddress({
    factory: SAFE_PROXY_FACTORY,
    singleton: MAINNET_SINGLETON,
    proxyCreationCode: SAFE_1_3_0_PROXY_CREATION_CODE,
    initializer: mainnetSafeSetup(owner, gnosisReceiver),
    saltNonce,
  });
}

export type ForwardOrder = {
  sellToken: Address; buyToken: Address; receiver: Address;
  sellAmount: string; buyAmount: string; validTo: number; appData: Hex;
  feeAmount: '0'; kind: 'sell'; partiallyFillable: false;
  sellTokenBalance: 'erc20'; buyTokenBalance: 'erc20';
};

export type ForwardPlan = {
  order: ForwardOrder;
  appDataJson: string;
  appDataHash: Hex;
  uid: Hex;
  mainnetSafe: Address;
  gnosisSafe: Address;
  mainnetSetup: Hex;   // setup() calldata (for permissionless deploy / recovery)
  gnosisSetup: Hex;
  saltNonce: string;   // decimal string
};

export type Hook = { target: Address; callData: Hex; gasLimit: string };

/** appData carrying the mainnet Safe-deploy POST-hook (runs after the fill funds
 *  the Safe with USDS, so the setup() can bridge the delivered balance). An optional
 *  PRE-hook (a gasless EIP-2612 permit) sets the sell-token allowance at settlement. */
function forwardAppData(postHookCalldata: Hex, preHook?: Hook): { json: string; hash: Hex } {
  const doc = {
    appCode: 'koeppelmann/sdai_bridge',
    metadata: { hooks: {
      pre: preHook ? [{ target: preHook.target, callData: preHook.callData, gasLimit: preHook.gasLimit }] : [],
      // 460k: measured mainnet Safe deploy+bridge ≈ 389k, + ~18% headroom. CoW
      // prices the fee off this declared gasLimit, so keep it tight but safe (too
      // low → the hook OOGs, Safe isn't deployed, USDS waits at the address).
      post: [{ target: SAFE_PROXY_FACTORY, callData: postHookCalldata, gasLimit: '460000' }],
    } },
    version: '1.6.0',
  };
  const json = JSON.stringify(doc);
  return { json, hash: keccak256(toHex(json)) };
}

/**
 * Build the forward CoW order (sell token X → USDS) plus its Safe-deploy post-hook.
 * @param saltNonce a random per-transfer nonce (uniqueness for the one-shot bridge).
 */
export function buildForwardPlan(opts: {
  owner: Address;
  sellToken: Address;
  sellAmount: bigint;   // exact input of token X
  minBuyUsds: bigint;   // slippage-adjusted USDS floor
  validTo: number;
  saltNonce: bigint;
  permitHook?: Hook;    // optional gasless EIP-2612 permit pre-hook
}): ForwardPlan {
  const { owner, sellToken, sellAmount, minBuyUsds, validTo, saltNonce, permitHook } = opts;
  const gnosisSafe = predictGnosisSafe(owner, saltNonce); // per-transfer, shares the salt
  const gnosisSetup = gnosisSafeSetup(owner);
  const mainnetSetup = mainnetSafeSetup(owner, gnosisSafe);
  const mainnetSafe = predictMainnetSafe(owner, gnosisSafe, saltNonce);

  const postHook = encodeFunctionData({
    abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce',
    args: [MAINNET_SINGLETON, mainnetSetup, saltNonce],
  });
  const { json, hash } = forwardAppData(postHook, permitHook);

  const order: ForwardOrder = {
    sellToken, buyToken: USDS, receiver: mainnetSafe,
    sellAmount: sellAmount.toString(), buyAmount: minBuyUsds.toString(),
    validTo, appData: hash, feeAmount: '0', kind: 'sell', partiallyFillable: false,
    sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
  };

  const digest = hashTypedData({
    domain: { name: 'Gnosis Protocol', version: 'v2', chainId: 1, verifyingContract: GPV2_SETTLEMENT },
    types: GPV2_ORDER_TYPES, primaryType: 'Order',
    message: {
      ...order, sellAmount, buyAmount: minBuyUsds, validTo: BigInt(validTo), feeAmount: 0n,
    } as never,
  });
  const uid = (digest + owner.slice(2) + validTo.toString(16).padStart(8, '0')).toLowerCase() as Hex;

  return { order, appDataJson: json, appDataHash: hash, uid, mainnetSafe, gnosisSafe, mainnetSetup, gnosisSetup, saltNonce: saltNonce.toString() };
}

// ---- reverse flow (Gnosis sDAI → mainnet USDS) ----

export const SDAI_PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

// Verified on-chain: reconstructing this domain reproduces sDAI.DOMAIN_SEPARATOR().
export const SDAI_PERMIT_DOMAIN = {
  name: 'Savings xDAI', version: '1', chainId: 100, verifyingContract: SDAI,
} as const;

/** Calldata for ReturnRouter.returnToMainnet(...) from a signed sDAI permit. */
export function returnToMainnetCalldata(opts: {
  amount: bigint; mainnetRecipient: Address; deadline: bigint;
  v: number; r: Hex; s: Hex;
}): Hex {
  return encodeFunctionData({
    abi: returnRouterAbi, functionName: 'returnToMainnet',
    args: [opts.amount, opts.mainnetRecipient, opts.deadline, opts.v, opts.r, opts.s],
  });
}
