import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { buildBalanceDeployment } from './twap';
import { decodeCarrier } from './carrierHistory';

// Round-trip: build a balance-sizing carrier's Safe-setup initializer the way the
// app does, wrap its bootstrap post-hook in an appData document, then decode it
// back. If encode and decode ever drift, this fails — which would silently strand
// carriers (the receiver Safe would no longer match the decoded params).

const SINGLETON = '0x3E5c63644E683549055b9Be8653de26E0B4CD36E' as const;
const BAL_INIT = '0x415667181180052B3fad7Bdf65185Ac730Dce0EC' as const;
const FALLBACK = '0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5' as const;
const BOOTSTRAP = '0x2C1aB2AF546f9157628dA8F8b50b6f5Ec9f21422' as const;
const OWNER = '0x000000000000000000000000000000000000bEEF' as const;
const SELL = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d' as const;
const BUY = '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1' as const;
const SALT = ('0x' + 'ab'.repeat(32)) as Hex;

const bootstrapAbi = parseAbi(['function bootstrap(address singleton, bytes setup, uint256 saltNonce)']);

function carrierAppData(saltNonce: bigint): string {
  const { initializer } = buildBalanceDeployment({
    owner: OWNER,
    config: {
      sellToken: SELL, buyToken: BUY, receiver: OWNER,
      n: 3n, t: 300n, span: 0n,
      limitNum: 36985500982776n, limitDen: 60000000000000000n,
      salt: SALT, appData: ('0x' + '00'.repeat(32)) as Hex,
    },
    twapBalanceInitializer: BAL_INIT,
    extensibleFallbackHandler: FALLBACK,
  });
  const callData: Hex = encodeFunctionData({
    abi: bootstrapAbi, functionName: 'bootstrap', args: [SINGLETON, initializer, saltNonce],
  });
  return JSON.stringify({
    appCode: 'koeppelmann/twap_carrier',
    metadata: { hooks: { pre: [], post: [{ target: BOOTSTRAP, callData, gasLimit: '600000' }] } },
    version: '1.6.0',
  });
}

describe('decodeCarrier round-trips the balance-sizing post-hook', () => {
  it('recovers singleton, saltNonce, owner, salt and the balance config', () => {
    const d = decodeCarrier(carrierAppData(0n), BOOTSTRAP);
    expect(d).not.toBeNull();
    expect(d!.singleton.toLowerCase()).toBe(SINGLETON.toLowerCase());
    expect(d!.saltNonce).toBe(0n);
    expect(d!.safeOwner.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(d!.salt.toLowerCase()).toBe(SALT.toLowerCase());
    expect(d!.common.sellToken.toLowerCase()).toBe(SELL.toLowerCase());
    expect(d!.common.buyToken.toLowerCase()).toBe(BUY.toLowerCase());
    expect(d!.common.n).toBe(3n);
    expect(d!.common.t).toBe(300n);
    expect(d!.balance).toBeDefined();
    expect(d!.balance!.limitNum).toBe(36985500982776n);
    expect(d!.balance!.limitDen).toBe(60000000000000000n);
    expect(d!.fixed).toBeUndefined();
  });

  it('rejects a document whose hook targets a different contract', () => {
    expect(decodeCarrier(carrierAppData(0n), '0x000000000000000000000000000000000000dEaD')).toBeNull();
  });

  it('rejects a non-carrier appData document', () => {
    expect(decodeCarrier(JSON.stringify({ appCode: 'something else', metadata: {} }), BOOTSTRAP)).toBeNull();
  });
});
