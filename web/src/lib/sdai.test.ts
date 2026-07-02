import { describe, it, expect } from 'vitest';
import { decodeFunctionData, type Address } from 'viem';
import { safeProxyFactoryAbi } from './abi';
import { predictSafeAddress } from './predict';
import { SAFE_1_3_0_PROXY_CREATION_CODE } from './__fixtures__/proxyCreationCode';
import {
  buildForwardPlan, predictGnosisSafe, predictMainnetSafe, mainnetSafeSetup,
  SAFE_PROXY_FACTORY, MAINNET_SINGLETON, USDS,
} from './sdai';

const OWNER = '0x1111111111111111111111111111111111111111' as Address;

describe('sdai forward plan', () => {
  it('derives a per-transfer Gnosis Safe (unique per saltNonce)', () => {
    expect(predictGnosisSafe(OWNER, 7n)).toBe(predictGnosisSafe(OWNER, 7n));
    expect(predictGnosisSafe(OWNER, 1n)).not.toBe(predictGnosisSafe(OWNER, 2n));
  });

  it("the order's post-hook deploys exactly the mainnet Safe the order pays into", () => {
    const plan = buildForwardPlan({
      owner: OWNER, sellToken: '0x2222222222222222222222222222222222222222' as Address,
      sellAmount: 10n ** 18n, minBuyUsds: 990n * 10n ** 15n, validTo: 2_000_000_000, saltNonce: 12345n,
    });

    // receiver of the order == the mainnet Safe
    expect(plan.order.receiver).toBe(plan.mainnetSafe);
    expect(plan.order.buyToken).toBe(USDS);

    // decode the appData post-hook (createProxyWithNonce) and re-derive the address
    const doc = JSON.parse(plan.appDataJson);
    const hook = doc.metadata.hooks.post[0];
    expect(hook.target).toBe(SAFE_PROXY_FACTORY);
    const { functionName, args } = decodeFunctionData({ abi: safeProxyFactoryAbi, data: hook.callData });
    expect(functionName).toBe('createProxyWithNonce');
    const [singleton, initializer, saltNonce] = args as [Address, `0x${string}`, bigint];
    expect(singleton).toBe(MAINNET_SINGLETON);
    expect(saltNonce).toBe(12345n);

    const reDerived = predictSafeAddress({
      factory: SAFE_PROXY_FACTORY, singleton: MAINNET_SINGLETON,
      proxyCreationCode: SAFE_1_3_0_PROXY_CREATION_CODE, initializer, saltNonce,
    });
    expect(reDerived).toBe(plan.mainnetSafe);

    // the initializer the hook deploys is exactly mainnetSafeSetup(owner, gnosisSafe)
    expect(initializer).toBe(mainnetSafeSetup(OWNER, plan.gnosisSafe));
    // the gnosis Safe is per-transfer, sharing the order's saltNonce
    expect(plan.gnosisSafe).toBe(predictGnosisSafe(OWNER, 12345n));
  });

  it('mainnet Safe address changes with saltNonce (per-transfer uniqueness)', () => {
    const g = predictGnosisSafe(OWNER, 1n);
    expect(predictMainnetSafe(OWNER, g, 1n)).not.toBe(predictMainnetSafe(OWNER, g, 2n));
  });

  it('uid is digest(32) ++ owner(20) ++ validTo(4) = 56 bytes', () => {
    const plan = buildForwardPlan({
      owner: OWNER, sellToken: '0x2222222222222222222222222222222222222222' as Address,
      sellAmount: 1n, minBuyUsds: 1n, validTo: 2_000_000_000, saltNonce: 1n,
    });
    expect(plan.uid.length).toBe(2 + 56 * 2);
    expect(plan.uid.slice(-8)).toBe((2_000_000_000).toString(16).padStart(8, '0'));
  });
});
