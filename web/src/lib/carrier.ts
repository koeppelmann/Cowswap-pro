import { encodeFunctionData, hashTypedData, keccak256, toHex, type Address, type Hex } from 'viem';
import type { ChainConfig } from './chains';
import type { Plan } from './plan';

// One signed in-kind GPv2 order whose pre-interaction CREATE2-deploys + arms the TWAP Safe,
// then funds it via the fill. Replaces the old "approve Safe + relayer deploys" two-step.

export const GPV2_ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' }, { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' }, { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' }, { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' }, { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' }, { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' }, { name: 'buyTokenBalance', type: 'string' },
  ],
} as const;

const BOOTSTRAP_ABI = [
  { type: 'function', stateMutability: 'nonpayable', name: 'bootstrap',
    inputs: [{ name: 'singleton', type: 'address' }, { name: 'setup', type: 'bytes' }, { name: 'saltNonce', type: 'uint256' }],
    outputs: [{ type: 'address' }] },
] as const;

export type CarrierOrder = {
  sellToken: Address; buyToken: Address; receiver: Address;
  sellAmount: string; buyAmount: string; validTo: number; appData: Hex;
  feeAmount: string; kind: 'sell'; partiallyFillable: false;
  sellTokenBalance: 'erc20'; buyTokenBalance: 'erc20';
};

export type Carrier = {
  order: CarrierOrder;
  appDataJson: string;   // PUT to the orderbook so solvers resolve the pre-hook
  appDataHash: Hex;
  uid: Hex;              // deterministic: GPv2 digest ++ owner ++ validTo
  bootstrapTarget: Address;
  bootstrapCalldata: Hex;
};

/** appData carrying the Safe-deploy POST-interaction. It must run AFTER the fill
 *  so the initializer can read the now-funded balance and split it into exact
 *  parts (zero dust). */
function carrierAppData(target: Address, calldata: Hex): { json: string; hash: Hex } {
  const doc = {
    appCode: 'koeppelmann/twap_carrier',
    metadata: { hooks: { pre: [], post: [{ target, callData: calldata, gasLimit: '600000' }] } },
    version: '1.6.0',
  };
  const json = JSON.stringify(doc);
  return { json, hash: keccak256(toHex(json)) };
}

/** Build the carrier order + its deterministic UID for a TWAP plan. */
export function buildTwapCarrier(opts: { plan: Plan; owner: Address; chain: ChainConfig; validTo: number }): Carrier {
  const { plan, owner, chain, validTo } = opts;
  if (!chain.twapBootstrap) throw new Error('carrier TWAP not available on this chain');
  const bootstrapCalldata = encodeFunctionData({
    abi: BOOTSTRAP_ABI, functionName: 'bootstrap',
    args: [chain.safeSingleton, plan.deployment.initializer, plan.saltNonce],
  });
  const { json, hash } = carrierAppData(chain.twapBootstrap, bootstrapCalldata);
  const order: CarrierOrder = {
    sellToken: plan.twap.sellToken, buyToken: plan.twap.sellToken, // in-kind
    receiver: plan.safeAddress,
    sellAmount: plan.carrierSellAmount.toString(),
    buyAmount: plan.carrierBuyMin.toString(),
    validTo, appData: hash, feeAmount: '0', kind: 'sell', partiallyFillable: false,
    sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
  };
  const digest = hashTypedData({
    domain: { name: 'Gnosis Protocol', version: 'v2', chainId: chain.chainId, verifyingContract: chain.cowSettlement },
    types: GPV2_ORDER_TYPES, primaryType: 'Order',
    message: {
      ...order, sellAmount: BigInt(order.sellAmount), buyAmount: BigInt(order.buyAmount),
      validTo: BigInt(validTo), feeAmount: 0n,
    } as never,
  });
  const uid = (digest + owner.slice(2) + validTo.toString(16).padStart(8, '0')).toLowerCase() as Hex;
  return { order, appDataJson: json, appDataHash: hash, uid, bootstrapTarget: chain.twapBootstrap, bootstrapCalldata };
}
