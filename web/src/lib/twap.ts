import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  zeroAddress,
  zeroHash,
} from 'viem';
import { safeAbi, twapDataAbi, twapSafeInitializerAbi } from './abi';

export const TWAP_HANDLER = '0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5' as const;

/** Mirrors TWAPOrder.Data from cowprotocol/composable-cow. */
export type TwapData = {
  sellToken: Address;
  buyToken: Address;
  receiver: Address; // zeroAddress -> the Safe itself
  partSellAmount: bigint;
  minPartLimit: bigint;
  t0: bigint; // 0 -> "start now" (read from cabinet at deploy time)
  n: bigint; // number of parts (> 1)
  t: bigint; // seconds per part (0 < t <= 365 days)
  span: bigint; // tradeable window per part; 0 -> whole part
  appData: Hex; // bytes32
};

export type ConditionalOrderParams = {
  handler: Address;
  salt: Hex;
  staticInput: Hex;
};

const paramsTupleAbi = {
  type: 'tuple',
  components: [
    { name: 'handler', type: 'address' },
    { name: 'salt', type: 'bytes32' },
    { name: 'staticInput', type: 'bytes' },
  ],
} as const;

/** abi.encode(TWAPOrder.Data) — the conditional order's `staticInput`. */
export function encodeTwapStaticInput(data: TwapData): Hex {
  return encodeAbiParameters([twapDataAbi], [data]);
}

export function buildConditionalOrderParams(data: TwapData, salt: Hex = zeroHash): ConditionalOrderParams {
  return { handler: TWAP_HANDLER, salt, staticInput: encodeTwapStaticInput(data) };
}

/** ComposableCoW.hash(params) == keccak256(abi.encode(params)). */
export function conditionalOrderHash(params: ConditionalOrderParams): Hex {
  return keccak256(encodeAbiParameters([paramsTupleAbi], [params]));
}

/** Calldata for TwapSafeInitializer.initialize(...) — the Safe setup delegatecall payload. */
export function encodeInitializeData(
  sellToken: Address,
  from: Address,
  pullAmount: bigint,
  approveAmount: bigint,
  params: ConditionalOrderParams,
): Hex {
  return encodeFunctionData({
    abi: twapSafeInitializerAbi,
    functionName: 'initialize',
    args: [sellToken, from, pullAmount, approveAmount, params],
  });
}

/** Full Safe.setup(...) calldata = the proxy `initializer` hashed into the CREATE2 salt. */
export function encodeSafeSetup(opts: {
  owner: Address;
  to: Address; // TwapSafeInitializer
  data: Hex; // initialize(...) calldata
  fallbackHandler: Address; // ExtensibleFallbackHandler
}): Hex {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: 'setup',
    args: [
      [opts.owner],
      1n,
      opts.to,
      opts.data,
      opts.fallbackHandler,
      zeroAddress,
      0n,
      zeroAddress,
    ],
  });
}

export type BuildDeploymentInput = {
  owner: Address;
  twap: TwapData;
  approveAmount: bigint;
  /** address to pull sell tokens from at deploy (the user); defaults to owner */
  from?: Address;
  /** amount to pull from `from` via transferFrom at deploy (allowance model) */
  pullAmount: bigint;
  twapSafeInitializer: Address;
  extensibleFallbackHandler: Address;
  salt?: Hex;
};

export type Deployment = {
  params: ConditionalOrderParams;
  orderHash: Hex;
  initData: Hex; // initialize(...) delegatecall payload
  initializer: Hex; // full Safe setup(...) calldata
};

/** Build everything needed to predict & deploy the Safe (chain-agnostic). */
export function buildDeployment(input: BuildDeploymentInput): Deployment {
  const params = buildConditionalOrderParams(input.twap, input.salt ?? zeroHash);
  const initData = encodeInitializeData(
    input.twap.sellToken,
    input.from ?? input.owner,
    input.pullAmount,
    input.approveAmount,
    params,
  );
  const initializer = encodeSafeSetup({
    owner: input.owner,
    to: input.twapSafeInitializer,
    data: initData,
    fallbackHandler: input.extensibleFallbackHandler,
  });
  return { params, orderHash: conditionalOrderHash(params), initData, initializer };
}
