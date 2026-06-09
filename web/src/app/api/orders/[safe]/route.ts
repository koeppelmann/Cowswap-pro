import { NextResponse } from 'next/server';
import { getOrder } from '../../../../lib/db';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: { safe: string } }) {
  const row = getOrder(params.safe);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ order: row });
}
