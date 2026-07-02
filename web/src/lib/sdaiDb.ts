import 'server-only';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Server-side record of "swap → sDAI on Gnosis" transfers. Powers cross-device
// status in the UI and lets the finalizer bot discover which Gnosis Safes to
// deploy + convert. Not authoritative — the CoW order + on-chain state are; this
// is a fast index.

const DB_PATH = process.env.TWAP_DB_PATH || '.data/orders.db';

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  const dir = dirname(DB_PATH);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const d = new Database(DB_PATH);
  d.pragma('journal_mode = WAL');
  d.exec(`
    CREATE TABLE IF NOT EXISTS sdai_transfers (
      uid          TEXT PRIMARY KEY,
      owner        TEXT NOT NULL,
      mainnetSafe  TEXT NOT NULL,
      gnosisSafe   TEXT NOT NULL,
      mainnetSetup TEXT NOT NULL,
      gnosisSetup  TEXT NOT NULL,
      saltNonce    TEXT NOT NULL,
      sellToken    TEXT NOT NULL,
      sellAmount   TEXT NOT NULL,
      createdAt    INTEGER NOT NULL,
      finalizedAt  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sdai_owner ON sdai_transfers(owner);
    CREATE INDEX IF NOT EXISTS idx_sdai_gnosis ON sdai_transfers(gnosisSafe);
  `);
  _db = d;
  return d;
}

export type SdaiTransfer = {
  uid: string;
  owner: string;
  mainnetSafe: string;
  gnosisSafe: string;
  mainnetSetup: string;
  gnosisSetup: string;
  saltNonce: string;
  sellToken: string;
  sellAmount: string;
  createdAt?: number;
  finalizedAt?: number | null;
};

export function recordTransfer(t: Omit<SdaiTransfer, 'createdAt' | 'finalizedAt'>): void {
  db().prepare(
    `INSERT INTO sdai_transfers (uid,owner,mainnetSafe,gnosisSafe,mainnetSetup,gnosisSetup,saltNonce,sellToken,sellAmount,createdAt)
     VALUES (@uid,@owner,@mainnetSafe,@gnosisSafe,@mainnetSetup,@gnosisSetup,@saltNonce,@sellToken,@sellAmount,@createdAt)
     ON CONFLICT(uid) DO NOTHING`,
  ).run({ ...t, createdAt: Math.floor(Date.now() / 1000) });
}

export function listTransfers(owner: string): SdaiTransfer[] {
  return db().prepare('SELECT * FROM sdai_transfers WHERE owner = ? COLLATE NOCASE ORDER BY createdAt DESC')
    .all(owner) as SdaiTransfer[];
}

/** Transfers not yet marked finalized — the finalizer's work queue (deduped by Gnosis Safe). */
export function listPending(): SdaiTransfer[] {
  return db().prepare('SELECT * FROM sdai_transfers WHERE finalizedAt IS NULL ORDER BY createdAt ASC')
    .all() as SdaiTransfer[];
}

export function markFinalized(gnosisSafe: string): void {
  db().prepare('UPDATE sdai_transfers SET finalizedAt = ? WHERE gnosisSafe = ? COLLATE NOCASE AND finalizedAt IS NULL')
    .run(Math.floor(Date.now() / 1000), gnosisSafe);
}
