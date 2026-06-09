import 'server-only';

// Server-side CoW API base. With a partner key, route through the partner
// gateway (higher rate limits); otherwise the public endpoint. The key stays on
// the server — never shipped to the browser.
export function cowBase(net: string): { url: string; headers: Record<string, string> } {
  const key = process.env.COW_API_KEY;
  if (key) return { url: `https://partners.cow.fi/${net}`, headers: { 'X-API-Key': key } };
  return { url: `https://api.cow.fi/${net}`, headers: {} };
}
