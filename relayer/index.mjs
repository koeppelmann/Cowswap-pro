// TWAP auto-deploy relayer.
//
// Watches every order in the app DB; the instant the owner has approved the
// predicted Safe to pull the sell token (allowance >= required) and holds the
// funds, it submits createProxyWithNonce so the user never sends a deploy tx.
// The Safe's setup pulls the tokens via transferFrom in that same tx. Deployment
// is permissionless and ownership is fixed by the initializer, so the relayer can
// deploy on anyone's behalf safely.
//
// Optional watch-tower fallback (WATCHTOWER=1): for deployed+active orders with
// no open part in the CoW orderbook, post the current part. The public CoW
// watch-tower already does this, so it's off by default.
//
// Env: RELAYER_PK (required), DB_PATH, MAINNET_RPC, GNOSIS_RPC, POLL_MS, WATCHTOWER

import Database from 'better-sqlite3';
import {
  createPublicClient, createWalletClient, http, fallback, decodeFunctionData, parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const ONCE = process.argv.includes('--once');
const DB_PATH = process.env.DB_PATH || '../web/.data/orders.db';
const POLL_MS = Number(process.env.POLL_MS || 8000);
const WATCHTOWER = process.env.WATCHTOWER === '1';

const CHAINS = {
  1: { rpcs: [process.env.MAINNET_RPC, 'https://ethereum-rpc.publicnode.com'].filter(Boolean), cow: 'mainnet' },
  100: {
    // NOTE: drpc/publicnode free tiers refuse eth_call on Gnosis — the relayer
    // needs eth_call for allowance/balanceOf checks, so use endpoints that serve it.
    rpcs: [process.env.GNOSIS_RPC, 'https://gnosis.oat.farm', 'https://gnosis-pokt.nodies.app', 'https://gnosis.api.onfinality.io/public'].filter(Boolean),
    cow: 'xdai',
  },
};

// remember safes we've seen deployed so we don't re-check them every tick
const deployedCache = new Set();
// back off orders that aren't ready (no allowance/funds yet) — re-check slowly
const notReady = new Map(); // safe -> last-checked ms
const NOT_READY_COOLDOWN_MS = 60_000;
const FRESH_WINDOW_MS = 15 * 60_000; // orders younger than this are polled every tick
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FACTORY = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2';
const COMPOSABLE_COW = '0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74';

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
const factoryAbi = parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)',
]);
const initAbi = parseAbi([
  'function initialize(address sellToken, address from, uint256 pullAmount, uint256 approveAmount, (address handler, bytes32 salt, bytes staticInput) params)',
]);
const setupAbi = parseAbi([
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
]);

function key() {
  const pk = process.env.RELAYER_PK;
  if (pk) return pk.startsWith('0x') ? pk : '0x' + pk;
  // dev fallback: the local deployer key
  const j = JSON.parse(readFileSync('../.deployer/key.json', 'utf8'));
  const k = j[0].private_key;
  return k.startsWith('0x') ? k : '0x' + k;
}
const account = privateKeyToAccount(key());

const clients = {};
function clientsFor(chainId) {
  if (clients[chainId]) return clients[chainId];
  const transport = fallback(CHAINS[chainId].rpcs.map((u) => http(u, { timeout: 10_000 })));
  const pub = createPublicClient({ transport });
  const wallet = createWalletClient({ account, transport });
  return (clients[chainId] = { pub, wallet });
}

// token + amounts decoded straight from the initializer (trustless).
function decodeRequirement(initializer) {
  const { args } = decodeFunctionData({ abi: setupAbi, data: initializer });
  const data = args[3]; // setup `data` = initialize(...) calldata
  const init = decodeFunctionData({ abi: initAbi, data });
  return { sellToken: init.args[0], from: init.args[1], pullAmount: init.args[2], approveAmount: init.args[3] };
}

async function tryDeploy(row) {
  const c = CHAINS[row.chainId];
  if (!c) return;
  if (deployedCache.has(row.safe.toLowerCase())) return; // already handled
  const { pub, wallet } = clientsFor(row.chainId);

  const code = await pub.getCode({ address: row.safe }).catch(() => undefined);
  if (code && code !== '0x') { deployedCache.add(row.safe.toLowerCase()); return; } // already deployed

  let req;
  try { req = decodeRequirement(row.initializer); } catch { return; }

  // Allowance model (the only model): deploy once the user has approved the Safe
  // to pull the sell tokens AND actually holds them. Tokens never sit in the
  // undeployed Safe — they're pulled from the owner via transferFrom at deploy.
  if (req.pullAmount <= 0n) { notReady.set(row.safe.toLowerCase(), Date.now()); return; }
  const [allowance, bal] = await Promise.all([
    pub.readContract({ address: req.sellToken, abi: erc20, functionName: 'allowance', args: [req.from, row.safe] }),
    pub.readContract({ address: req.sellToken, abi: erc20, functionName: 'balanceOf', args: [req.from] }),
  ]);
  if (allowance < req.pullAmount || bal < req.pullAmount) { notReady.set(row.safe.toLowerCase(), Date.now()); return; }
  console.log(`[deploy] ${row.safe} approved+funded by ${req.from}; deploying…`);
  const hash = await wallet.writeContract({
    address: FACTORY, abi: factoryAbi, functionName: 'createProxyWithNonce',
    args: [row.singleton, row.initializer, BigInt(row.saltNonce)],
    chain: null,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  deployedCache.add(row.safe.toLowerCase());
  console.log(`[deploy] ${row.safe} -> ${rcpt.status} tx ${hash}`);
}

async function tick() {
  let db;
  try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
  catch (e) { console.log('[db] not ready:', e.message); return; }
  const rows = db.prepare('SELECT * FROM orders ORDER BY createdAt DESC').all();
  db.close();
  const now = Date.now();
  for (const row of rows) {
    const key = row.safe.toLowerCase();
    if (deployedCache.has(key)) continue; // already deployed
    // Orders created recently are in the "active submission" window — the user is
    // likely approving right now, so check them EVERY tick (fast auto-deploy).
    // Only apply the not-ready backoff to older/abandoned drafts.
    const ageMs = now - (row.createdAt || 0) * 1000;
    const fresh = ageMs < FRESH_WINDOW_MS;
    const last = notReady.get(key);
    if (!fresh && last && now - last < NOT_READY_COOLDOWN_MS) continue; // backoff abandoned/not-ready
    try { await tryDeploy(row); } catch (e) {
      notReady.set(key, Date.now()); // RPC hiccup — back off, retry later
      console.log(`[deploy] ${row.safe} error:`, e.shortMessage || e.message);
    }
    if (WATCHTOWER) { try { await postPart(row); } catch { /* best-effort */ } }
    await sleep(120); // throttle to stay under RPC rate limits
  }
}

// --- optional watch-tower fallback (off by default) ---
const ccowReadAbi = parseAbi([
  'function getTradeableOrderWithSignature(address owner, (address handler, bytes32 salt, bytes staticInput) params, bytes offchainInput, bytes32[] proof) view returns ((address sellToken, address buyToken, address receiver, uint256 sellAmount, uint256 buyAmount, uint32 validTo, bytes32 appData, uint256 feeAmount, bytes32 kind, bool partiallyFillable, bytes32 sellTokenBalance, bytes32 buyTokenBalance) order, bytes signature)',
]);
async function postPart(row) {
  const c = CHAINS[row.chainId];
  const { pub } = clientsFor(row.chainId);
  const code = await pub.getCode({ address: row.safe }).catch(() => undefined);
  if (!code || code === '0x') return; // not deployed yet
  // reconstruct params from the registered staticInput via the initializer
  const { args } = decodeFunctionData({ abi: setupAbi, data: row.initializer });
  const init = decodeFunctionData({ abi: initAbi, data: args[3] });
  const params = init.args[4];
  let res;
  try {
    res = await pub.readContract({ address: COMPOSABLE_COW, abi: ccowReadAbi, functionName: 'getTradeableOrderWithSignature', args: [row.safe, params, '0x', []] });
  } catch { return; } // no tradeable part right now
  const [order, signature] = res;
  const body = {
    sellToken: order.sellToken, buyToken: order.buyToken, receiver: order.receiver,
    sellAmount: order.sellAmount.toString(), buyAmount: order.buyAmount.toString(),
    validTo: Number(order.validTo), appData: order.appData, feeAmount: '0',
    kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
    signingScheme: 'eip1271', signature, from: row.safe,
  };
  const r = await fetch(`https://api.cow.fi/${c.cow}/api/v1/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.ok) console.log(`[watchtower] posted part for ${row.safe}`);
}

console.log(`relayer up — account ${account.address}, db ${DB_PATH}, watchtower=${WATCHTOWER}, once=${ONCE}`);
await tick();
if (!ONCE) setInterval(tick, POLL_MS);
