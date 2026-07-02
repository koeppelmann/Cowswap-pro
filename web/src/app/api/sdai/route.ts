import { NextResponse } from 'next/server';
import { recordTransfer, listTransfers, listPending, markFinalized, type SdaiTransfer } from '../../../lib/sdaiDb';

export const runtime = 'nodejs';

// Index of "swap → sDAI on Gnosis" transfers.
//   GET  ?owner=0x..   -> that owner's transfers (UI status)
//   GET  ?op=pending   -> all not-yet-finalized transfers (finalizer queue)
//   POST { op:'record', transfer }    -> record a new transfer
//   POST { op:'finalized', gnosisSafe } -> mark a Gnosis Safe finalized

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('op') === 'pending') {
    return NextResponse.json({ transfers: listPending() });
  }
  const owner = url.searchParams.get('owner');
  if (!owner) return NextResponse.json({ error: 'owner required' }, { status: 400 });
  return NextResponse.json({ transfers: listTransfers(owner) });
}

export async function POST(req: Request) {
  let b: { op?: string; transfer?: SdaiTransfer; gnosisSafe?: string };
  try { b = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  if (b.op === 'record' && b.transfer) {
    const t = b.transfer;
    const required = ['uid', 'owner', 'mainnetSafe', 'gnosisSafe', 'mainnetSetup', 'gnosisSetup', 'saltNonce', 'sellToken', 'sellAmount'] as const;
    for (const k of required) if (!t[k]) return NextResponse.json({ error: `missing ${k}` }, { status: 400 });
    try { recordTransfer(t); return NextResponse.json({ ok: true }); }
    catch (e) { return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 }); }
  }
  if (b.op === 'finalized' && b.gnosisSafe) {
    markFinalized(b.gnosisSafe);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: 'unknown op' }, { status: 400 });
}
