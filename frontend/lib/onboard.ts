// Carrier-order onboarding constants + IntentBootstrap6 ABI (Gnosis staging/barn).
export const ONBOARD = {
  chainId: 100,
  intentBootstrap: '0x325afB837204D46A3D4158deD26a8BE2681761B5', // IntentBootstrap15 (module v5 + signed open minHF)
  settlement: '0xf553d092b50bdcbddeD1A99aF2cA29FBE5E2CB13', // barn
  relayer: '0xC7242d167563352E2BCA4d71C043fbe542DB8FB2', // barn vault relayer
  wxdai: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
  weth: '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1',
  aweth: '0xa818F1B57c201E092C4A2017A91815034326Efd1',
  vdebtWxdai: '0x281963D7471eCdC3A2Bd4503e24e89691cfe420D',
} as const;

// (address owner,uint256 equity,uint256 flash,uint256 buyMin,uint256 borrow,uint256 repay,uint32 validTo,uint256 nonce)
const INTENT = {
  type: 'tuple',
  name: 'it',
  components: [
    { name: 'owner', type: 'address' }, { name: 'equity', type: 'uint256' },
    { name: 'flash', type: 'uint256' }, { name: 'buyMin', type: 'uint256' },
    { name: 'borrow', type: 'uint256' }, { name: 'repay', type: 'uint256' },
    { name: 'validTo', type: 'uint32' }, { name: 'nonce', type: 'uint256' },
    { name: 'collateral', type: 'address' }, { name: 'debt', type: 'address' },
    { name: 'eMode', type: 'uint8' }, { name: 'minHealthFactor', type: 'uint256' },
  ],
} as const;

export const IB_ABI = [
  { type: 'function', stateMutability: 'view', name: 'safeOf', inputs: [INTENT], outputs: [{ type: 'address' }] },
  { type: 'function', stateMutability: 'view', name: 'appData', inputs: [INTENT, { name: 'safe', type: 'address' }], outputs: [{ type: 'string' }, { type: 'bytes32' }] },
  { type: 'function', stateMutability: 'view', name: 'uid', inputs: [INTENT, { name: 'safe', type: 'address' }], outputs: [{ type: 'bytes' }] },
  { type: 'function', stateMutability: 'nonpayable', name: 'bootstrap', inputs: [INTENT], outputs: [{ type: 'address' }, { type: 'bytes' }] },
] as const;

export const ERC20_ABI = [
  { type: 'function', stateMutability: 'view', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', stateMutability: 'view', name: 'allowance', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', stateMutability: 'nonpayable', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

export type Intent = {
  owner: `0x${string}`; equity: bigint; flash: bigint; buyMin: bigint;
  borrow: bigint; repay: bigint; validTo: number; nonce: bigint;
  collateral: `0x${string}`; debt: `0x${string}`; eMode: number; minHealthFactor: bigint;
};

// GPv2 order EIP-712 types for signing the carrier order.
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

// ---- Close (relay) ----
export const CLOSE_HELPER = '0x91886ba723Ce332c87ede9985b73A4a37Cd1a16f';

const CLOSE_STRUCT = {
  type: 'tuple', name: 'c',
  components: [
    { name: 'safe', type: 'address' }, { name: 'sellWeth', type: 'uint256' },
    { name: 'buyMin', type: 'uint256' }, { name: 'flash', type: 'uint256' },
    { name: 'repay', type: 'uint256' }, { name: 'validTo', type: 'uint32' }, { name: 'nonce', type: 'uint256' },
  ],
} as const;

export const CLOSE_ABI = [
  { type: 'function', stateMutability: 'view', name: 'build', inputs: [CLOSE_STRUCT],
    outputs: [{ name: 'target', type: 'address' }, { name: 'registerCalldata', type: 'bytes' }, { name: 'json', type: 'string' }, { name: 'hash', type: 'bytes32' }, { name: 'orderUid', type: 'bytes' }] },
] as const;

export const SAFE_ABI = [
  { type: 'function', stateMutability: 'view', name: 'nonce', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', stateMutability: 'view', name: 'orderStatusUnused', inputs: [], outputs: [] },
] as const;

export const WRAPPER_ABI = [
  { type: 'function', stateMutability: 'view', name: 'orderStatus', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint8' }] },
] as const;

// Safe v1.3.0 EIP-712 SafeTx type — the user signs this; the resulting 65-byte sig is the
// `signatures` arg of execTransaction (v=27/28, directly accepted for the owner).
export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
} as const;

export const WRAPPER_ADDR = '0x531636e6e18F3A52c283aCCda39D7185E4597A37';

// ---- Management (LevManagerModule, signed Retarget intents) ----
export const LEV_MODULE = '0x239D413A6Ac5322D3ccAaaf43e34045bdAcD7E74'; // v5: partial-close payout to receiver (withdrawExtra)
export const LEV_MODULE_V4 = '0xbd913B8626DD7ACe1810E1797C93f27dD7906A5C'; // v4 — still enabled on Safes opened before v5
// v4 Retarget lacks withdrawExtra (14 fields)
export const RETARGET_TYPES_V4 = {
  Retarget: [
    { name: 'safe', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    { name: 'mode', type: 'uint8' }, { name: 'collateral', type: 'address' }, { name: 'debt', type: 'address' },
    { name: 'sellAmount', type: 'uint256' }, { name: 'repayAmount', type: 'uint256' }, { name: 'minBuy', type: 'uint256' },
    { name: 'flash', type: 'uint256' }, { name: 'orderValidTo', type: 'uint32' }, { name: 'minHealthFactor', type: 'uint256' },
    { name: 'receiver', type: 'address' }, { name: 'triggerHealthFactor', type: 'uint256' },
  ],
} as const;
export const POOL_ADDR = '0xb50201558B00496A145fE76f7424749556E326D8';
export const AWETH_ADDR = '0xa818F1B57c201E092C4A2017A91815034326Efd1';
export const VDEBT_WXDAI = '0x281963D7471eCdC3A2Bd4503e24e89691cfe420D';

const RETARGET_STRUCT = {
  type: 'tuple', name: 'r',
  components: [
    { name: 'safe', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    { name: 'mode', type: 'uint8' }, { name: 'collateral', type: 'address' }, { name: 'debt', type: 'address' },
    { name: 'sellAmount', type: 'uint256' }, { name: 'repayAmount', type: 'uint256' }, { name: 'minBuy', type: 'uint256' },
    { name: 'flash', type: 'uint256' }, { name: 'orderValidTo', type: 'uint32' }, { name: 'minHealthFactor', type: 'uint256' },
    { name: 'receiver', type: 'address' }, { name: 'triggerHealthFactor', type: 'uint256' },
    { name: 'withdrawExtra', type: 'uint256' },
  ],
} as const;

// v4 preview (14-field Retarget, no withdrawExtra) — for Safes opened before v5
const RETARGET_STRUCT_V4 = {
  type: 'tuple', name: 'r',
  components: RETARGET_STRUCT.components.filter((c) => c.name !== 'withdrawExtra'),
} as const;
export const MODULE_ABI_V4 = [
  { type: 'function', stateMutability: 'view', name: 'preview', inputs: [RETARGET_STRUCT_V4],
    outputs: [{ name: 'uid', type: 'bytes' }, { name: 'json', type: 'string' }, { name: 'appHash', type: 'bytes32' }] },
] as const;

export const MODULE_ABI = [
  { type: 'function', stateMutability: 'view', name: 'preview', inputs: [RETARGET_STRUCT],
    outputs: [{ name: 'uid', type: 'bytes' }, { name: 'json', type: 'string' }, { name: 'appHash', type: 'bytes32' }] },
  { type: 'function', stateMutability: 'view', name: 'metaNonceOf', inputs: [RETARGET_STRUCT], outputs: [{ type: 'uint256' }] },
  { type: 'function', stateMutability: 'nonpayable', name: 'execute', inputs: [RETARGET_STRUCT, { name: 'sig', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
] as const;

export const POOL_ABI = [
  { type: 'function', stateMutability: 'view', name: 'getUserAccountData', inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }] },
] as const;

// EIP-712 Retarget type for signing (domain = LevManagerModule).
export const RETARGET_TYPES = {
  Retarget: [
    { name: 'safe', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    { name: 'mode', type: 'uint8' }, { name: 'collateral', type: 'address' }, { name: 'debt', type: 'address' },
    { name: 'sellAmount', type: 'uint256' }, { name: 'repayAmount', type: 'uint256' }, { name: 'minBuy', type: 'uint256' },
    { name: 'flash', type: 'uint256' }, { name: 'orderValidTo', type: 'uint32' }, { name: 'minHealthFactor', type: 'uint256' },
    { name: 'receiver', type: 'address' }, { name: 'triggerHealthFactor', type: 'uint256' },
    { name: 'withdrawExtra', type: 'uint256' },
  ],
} as const;
