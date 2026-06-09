import 'server-only';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Server-side persistence for TWAP orders. Primary, fast record of every order
// created — paired with the on-chain registry (trustless backup) and the user's
// downloadable recovery file. SQLite now; swap for Postgres in prod.

const DB_PATH = process.env.TWAP_DB_PATH || '.data/orders.db';

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  const dir = dirname(DB_PATH);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const d = new Database(DB_PATH);
  d.pragma('journal_mode = WAL');
  d.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      safe          TEXT PRIMARY KEY,
      chainId       INTEGER NOT NULL,
      owner         TEXT NOT NULL,
      receiver      TEXT NOT NULL,
      sellToken     TEXT NOT NULL,
      buyToken      TEXT NOT NULL,
      totalSell     TEXT NOT NULL,
      partSell      TEXT NOT NULL,
      minPartLimit  TEXT NOT NULL,
      n             INTEGER NOT NULL,
      t             INTEGER NOT NULL,
      orderHash     TEXT NOT NULL,
      singleton     TEXT NOT NULL,
      saltNonce     TEXT NOT NULL,
      initializer   TEXT NOT NULL,
      createdAt     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_owner ON orders(chainId, owner);
  `);
  // status cache columns (added via migration; cheap on-chain state refreshed in background)
  for (const col of ['status TEXT', 'statusAt INTEGER']) {
    try { d.exec(`ALTER TABLE orders ADD COLUMN ${col}`); } catch { /* already exists */ }
  }
  _db = d;
  return d;
}

export type OrderStatusJSON = {
  deployed: boolean; active: boolean; filledParts: number;
  executedSell: string; executedBuy: string; remainingSell: string; startTime: number;
  allowance?: string; // sellToken.allowance(owner, safe) — approve-flow signal
};

export function updateStatus(safe: string, status: OrderStatusJSON): void {
  db().prepare('UPDATE orders SET status = ?, statusAt = ? WHERE safe = ? COLLATE NOCASE')
    .run(JSON.stringify(status), Math.floor(Date.now() / 1000), safe);
}

/** Batch-write statuses in a single transaction (used by the lens refresher). */
export function updateStatusMany(updates: Array<{ safe: string; status: OrderStatusJSON }>): void {
  const at = Math.floor(Date.now() / 1000);
  const stmt = db().prepare('UPDATE orders SET status = ?, statusAt = ? WHERE safe = ? COLLATE NOCASE');
  const tx = db().transaction((rows: Array<{ safe: string; status: OrderStatusJSON }>) => {
    for (const r of rows) stmt.run(JSON.stringify(r.status), at, r.safe);
  });
  tx(updates);
}

export type OrderRow = {
  safe: string;
  chainId: number;
  owner: string;
  receiver: string;
  sellToken: string;
  buyToken: string;
  totalSell: string;
  partSell: string;
  minPartLimit: string;
  n: number;
  t: number;
  orderHash: string;
  singleton: string;
  saltNonce: string;
  initializer: string;
  createdAt: number;
  status?: string | null; // JSON of OrderStatusJSON, refreshed in background
  statusAt?: number | null;
};

export function upsertOrder(o: Omit<OrderRow, 'createdAt'>): void {
  db()
    .prepare(
      `INSERT INTO orders (safe,chainId,owner,receiver,sellToken,buyToken,totalSell,partSell,minPartLimit,n,t,orderHash,singleton,saltNonce,initializer,createdAt)
       VALUES (@safe,@chainId,@owner,@receiver,@sellToken,@buyToken,@totalSell,@partSell,@minPartLimit,@n,@t,@orderHash,@singleton,@saltNonce,@initializer,@createdAt)
       ON CONFLICT(safe) DO NOTHING`,
    )
    .run({ ...o, createdAt: Math.floor(Date.now() / 1000) });
}

export function getOrder(safe: string): OrderRow | undefined {
  return db().prepare('SELECT * FROM orders WHERE safe = ? COLLATE NOCASE').get(safe) as OrderRow | undefined;
}

export function listOrders(chainId: number, owner: string): OrderRow[] {
  return db()
    .prepare('SELECT * FROM orders WHERE chainId = ? AND owner = ? COLLATE NOCASE ORDER BY createdAt DESC')
    .all(chainId, owner) as OrderRow[];
}
