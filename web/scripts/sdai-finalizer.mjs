#!/usr/bin/env node
// sDAI finalizer bot.
//
// Watches for bridged native xDAI arriving at users' Gnosis Safes and finalizes
// the second leg: deploy the Safe (if needed) then call ConvertModule.convert(safe),
// which turns the xDAI into sDAI for the owner and pays THIS caller a 0.01 xDAI tip.
// Liveness = incentive: the tip covers gas, so any keeper (not just us) will do it.
//
// Discovery: polls the app's /api/sdai?op=pending queue. Each entry carries the
// gnosisSafe + its setup() calldata (so we can deploy) + saltNonce.
//
// Env:
//   FINALIZER_PK   0x-private key of a funded Gnosis account (required)
//   GNOSIS_RPC     Gnosis RPC url (default https://rpc.gnosischain.com)
//   APP_URL        base url of the app (default http://localhost:3100)
//   POLL_MS        poll interval (default 60000)
//
// One-shot direct mode (no app needed): pass a Safe address + its setup calldata:
//   node sdai-finalizer.mjs <gnosisSafe> [gnosisSetupHex]

import { createPublicClient, createWalletClient, http, getAddress } from 'viem';
import { gnosis } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const CONVERT_MODULE = '0x7cE6e4fe5c6658FF3f98C417Da09E6C31c9aAae3';
const FINALIZE_HELPER = '0xBA6F734194255dF301064F3b1eBA3E428733ECeB'; // atomic deploy+convert+tip
const GNOSIS_SINGLETON = '0x3E5c63644E683549055b9Be8653de26E0B4CD36E';
const TIP = 10n ** 16n; // 0.01 xDAI

const RPC = process.env.GNOSIS_RPC || 'https://rpc.gnosischain.com';
const APP_URL = process.env.APP_URL || 'http://localhost:3100';
const POLL_MS = Number(process.env.POLL_MS || 60_000);

const convertAbi = [{ type: 'function', name: 'convert', stateMutability: 'nonpayable', inputs: [{ name: 'safe', type: 'address' }], outputs: [] }];
const helperAbi = [{ type: 'function', name: 'finalize', stateMutability: 'nonpayable', inputs: [{ name: 'singleton', type: 'address' }, { name: 'setup', type: 'bytes' }, { name: 'saltNonce', type: 'uint256' }], outputs: [{ type: 'address' }] }];

const pk = process.env.FINALIZER_PK;
if (!pk) { console.error('FINALIZER_PK required'); process.exit(1); }
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: gnosis, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: gnosis, transport: http(RPC) });

async function finalize(safe, gnosisSetup, saltNonce = 0n) {
  safe = getAddress(safe);
  const bal = await pub.getBalance({ address: safe });
  if (bal <= TIP) { console.log(`  ${safe} balance ${bal} <= tip — waiting for bridge / nothing to do`); return false; }
  const code = await pub.getCode({ address: safe });
  let hash;
  if (code && code !== '0x') {
    // Already deployed → convert directly (no deploy, so no deploy-gas-vs-tip race).
    console.log(`  converting deployed ${safe} (balance ${bal}) …`);
    hash = await wallet.writeContract({ address: CONVERT_MODULE, abi: convertAbi, functionName: 'convert', args: [safe] });
  } else {
    // Not deployed → ATOMIC deploy+convert+tip via the helper. All-or-nothing: if a
    // competing keeper front-runs, the whole tx reverts and we pay no deploy gas.
    if (!gnosisSetup) { console.log(`  ${safe} undeployed and no setup provided — skip`); return false; }
    console.log(`  atomic finalize (deploy+convert) ${safe} (balance ${bal}) …`);
    hash = await wallet.writeContract({ address: FINALIZE_HELPER, abi: helperAbi, functionName: 'finalize', args: [GNOSIS_SINGLETON, gnosisSetup, saltNonce] });
  }
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  ✅ finalized (${hash}) — sDAI to owner, 0.01 xDAI tip claimed`);
  return true;
}

async function markFinalized(gnosisSafe) {
  try { await fetch(`${APP_URL}/api/sdai`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'finalized', gnosisSafe }) }); } catch {}
}

async function pollOnce() {
  let transfers = [];
  try {
    const r = await fetch(`${APP_URL}/api/sdai?op=pending`);
    transfers = (await r.json()).transfers || [];
  } catch (e) { console.error('poll failed:', e.message); return; }
  // dedupe by gnosisSafe
  const seen = new Set();
  for (const t of transfers) {
    const key = t.gnosisSafe.toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    try {
      console.log(`checking ${t.gnosisSafe} (owner ${t.owner})`);
      if (await finalize(t.gnosisSafe, t.gnosisSetup, BigInt(t.saltNonce || '0'))) await markFinalized(t.gnosisSafe);
    } catch (e) { console.error(`  error finalizing ${t.gnosisSafe}:`, e.shortMessage || e.message); }
  }
}

async function main() {
  console.log(`finalizer: ${account.address} on Gnosis (${RPC})`);
  const arg = process.argv[2];
  if (arg) { await finalize(arg, process.argv[3], BigInt(process.argv[4] || '0')); return; } // one-shot: <safe> <setup> <saltNonce>
  for (;;) { await pollOnce(); await new Promise((res) => setTimeout(res, POLL_MS)); }
}
main().catch((e) => { console.error(e); process.exit(1); });
