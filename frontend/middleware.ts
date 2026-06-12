import { NextRequest, NextResponse } from 'next/server';

// The app moved: twap.koeppelmann.dev → cowswap.koeppelmann.dev (paths preserved).
// API routes are exempt so anything scripted against the old host keeps working.
export function middleware(req: NextRequest) {
  const host = req.headers.get('host') ?? '';
  if (host === 'twap.koeppelmann.dev' && !req.nextUrl.pathname.startsWith('/api/')) {
    const url = new URL(req.nextUrl.pathname + req.nextUrl.search, 'https://cowswap.koeppelmann.dev');
    return NextResponse.redirect(url, 308);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/).*)'] };
