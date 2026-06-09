import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import {
  buildConditionalOrderParams,
  buildDeployment,
  encodeInitializeData,
  encodeTwapStaticInput,
  type TwapData,
} from './twap';
import { predictSafeAddress } from './predict';
import { SAFE_1_3_0_PROXY_CREATION_CODE } from './__fixtures__/proxyCreationCode';

// Ground-truth values emitted by contracts/script/Vector.s.sol for identical
// fixed inputs. The Solidity encoding is itself proven correct on-chain by the
// Gnosis fork test. If these match, the TS SDK produces byte-identical calldata
// and the same deterministic Safe address as the contracts.
const VECTOR = {
  user: '0x000000000000000000000000000000000000bEEF',
  helper: '0x3afA7DB0BEC365b4CF169A3556acDDe6653d0E18',
  fallbackHandler: '0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5',
  factory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
  singleton: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E',
  staticInputHash: '0x96b0cac143d10b4e389bb3fffb1655fc30bedfa9550a1210106e08722ff30f07',
  initDataHash: '0xbdb93febc6a930f28f6f62f45bbff83471206ea5413eaab65486d3d82065febf',
  initializerHash: '0x345cf4400a7b0dbce431381d726532b7d57d0bf56e2bdc3045c1c347799acba4',
  predicted: '0x2Ecb768c09e44C585862a6B2672F973E26923fc1',
} as const;

const twap: TwapData = {
  sellToken: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', // WXDAI
  buyToken: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83', // USDC
  receiver: '0x0000000000000000000000000000000000000000',
  partSellAmount: 100_000000000000000000n, // 100e18
  minPartLimit: 95_000000n, // 95e6
  t0: 0n,
  n: 5n,
  t: 3600n,
  span: 0n,
  appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
};
const approveAmount = 500_000000000000000000n; // 100e18 * 5

describe('TWAP SDK cross-check against on-chain-proven Solidity vector', () => {
  it('encodes staticInput identically', () => {
    expect(keccak256(encodeTwapStaticInput(twap))).toBe(VECTOR.staticInputHash);
  });

  it('encodes the initialize() delegatecall identically', () => {
    const params = buildConditionalOrderParams(twap);
    // allowance model: from = user, pullAmount = approveAmount
    expect(keccak256(encodeInitializeData(twap.sellToken, VECTOR.user, approveAmount, approveAmount, params))).toBe(
      VECTOR.initDataHash,
    );
  });

  it('encodes the full Safe setup() initializer identically', () => {
    const { initializer } = buildDeployment({
      owner: VECTOR.user,
      twap,
      approveAmount,
      from: VECTOR.user,
      pullAmount: approveAmount,
      twapSafeInitializer: VECTOR.helper,
      extensibleFallbackHandler: VECTOR.fallbackHandler,
    });
    expect(keccak256(initializer)).toBe(VECTOR.initializerHash);
  });

  it('predicts the same deterministic Safe address as the factory', () => {
    const { initializer } = buildDeployment({
      owner: VECTOR.user,
      twap,
      approveAmount,
      from: VECTOR.user,
      pullAmount: approveAmount,
      twapSafeInitializer: VECTOR.helper,
      extensibleFallbackHandler: VECTOR.fallbackHandler,
    });
    const predicted = predictSafeAddress({
      factory: VECTOR.factory,
      singleton: VECTOR.singleton,
      proxyCreationCode: SAFE_1_3_0_PROXY_CREATION_CODE,
      initializer,
      saltNonce: 0n,
    });
    expect(predicted).toBe(VECTOR.predicted);
  });
});
