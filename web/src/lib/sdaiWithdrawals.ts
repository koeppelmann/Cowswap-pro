import type { Address, Hex } from 'viem';

// Client-side record of reverse (sDAI → mainnet USDS) withdrawals awaiting their
// mainnet claim. Kept in localStorage keyed by owner — the claim is a separate
// user tx (often minutes later, after validators sign), so we persist the tx hash
// to rebuild the claim from on-chain data. Not authoritative; the bridge is.

export type PendingWithdrawal = { txHash: Hex; createdAt: number };

const key = (owner: string) => `sdai-withdrawals-${owner.toLowerCase()}`;

export function listWithdrawals(owner: Address): PendingWithdrawal[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(key(owner)) || '[]'); } catch { return []; }
}

export function saveWithdrawal(owner: Address, txHash: Hex): void {
  if (typeof window === 'undefined') return;
  const list = listWithdrawals(owner);
  if (list.some((w) => w.txHash.toLowerCase() === txHash.toLowerCase())) return;
  list.unshift({ txHash, createdAt: Math.floor(Date.now() / 1000) });
  localStorage.setItem(key(owner), JSON.stringify(list.slice(0, 50)));
}

export function removeWithdrawal(owner: Address, txHash: Hex): void {
  if (typeof window === 'undefined') return;
  const list = listWithdrawals(owner).filter((w) => w.txHash.toLowerCase() !== txHash.toLowerCase());
  localStorage.setItem(key(owner), JSON.stringify(list));
}
