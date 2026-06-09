import { NextResponse } from 'next/server';
import { triggerDeploy } from '../../../lib/deployer';

export const runtime = 'nodejs';

// Client calls this the moment it detects the allowance is set, to deploy the
// Safe immediately (instead of waiting for the polling relayer).
export async function POST(req: Request) {
  let safe = '';
  try { safe = String((await req.json())?.safe || ''); } catch { /* ignore */ }
  if (!/^0x[0-9a-fA-F]{40}$/.test(safe)) return NextResponse.json({ status: 'error', error: 'bad safe' }, { status: 400 });
  const result = await triggerDeploy(safe);
  return NextResponse.json(result);
}
