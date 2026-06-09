// Minimal viem-typed ABIs for the contracts the dapp touches.

export const erc20Abi = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

export const safeProxyFactoryAbi = [
  {
    type: 'function',
    name: 'createProxyWithNonce',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
  },
  {
    type: 'function',
    name: 'proxyCreationCode',
    stateMutability: 'pure',
    inputs: [],
    outputs: [{ type: 'bytes' }],
  },
] as const;

// Safe.setup(...) — the initializer call hashed into the CREATE2 salt.
export const safeAbi = [
  {
    type: 'function',
    name: 'setup',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

// The `ConditionalOrderParams` tuple, reused below.
const conditionalOrderParams = {
  type: 'tuple',
  name: 'params',
  components: [
    { name: 'handler', type: 'address' },
    { name: 'salt', type: 'bytes32' },
    { name: 'staticInput', type: 'bytes' },
  ],
} as const;

export const twapSafeInitializerAbi = [
  {
    type: 'function',
    name: 'initialize',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sellToken', type: 'address' },
      { name: 'from', type: 'address' },
      { name: 'pullAmount', type: 'uint256' },
      { name: 'approveAmount', type: 'uint256' },
      conditionalOrderParams,
    ],
    outputs: [],
  },
] as const;

export const composableCowAbi = [
  { type: 'function', name: 'domainSeparator', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  {
    type: 'function',
    name: 'hash',
    stateMutability: 'pure',
    inputs: [conditionalOrderParams],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'singleOrders',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'orderHash', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'remove',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'singleOrderHash', type: 'bytes32' }],
    outputs: [],
  },
] as const;

export const twapDeploymentRegistryAbi = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'singleton', type: 'address' },
      { name: 'saltNonce', type: 'uint256' },
      { name: 'initializer', type: 'bytes' },
    ],
    outputs: [{ name: 'safe', type: 'address' }],
  },
] as const;

// abi.encode(TWAPOrder.Data) — the conditional order's staticInput.
export const twapDataAbi = {
  type: 'tuple',
  components: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'partSellAmount', type: 'uint256' },
    { name: 'minPartLimit', type: 'uint256' },
    { name: 't0', type: 'uint256' },
    { name: 'n', type: 'uint256' },
    { name: 't', type: 'uint256' },
    { name: 'span', type: 'uint256' },
    { name: 'appData', type: 'bytes32' },
  ],
} as const;
