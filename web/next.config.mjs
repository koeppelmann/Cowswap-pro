/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Lint separately (npm run lint); don't fail the production build on lint. TS is still enforced.
  eslint: { ignoreDuringBuilds: true },
  // better-sqlite3 is a native module — don't bundle it into the server build.
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
  // Order-book depth viewer (standalone Python service, see /orderbook-viewer) is
  // mounted same-origin under /orderbook/* so its relative asset/data fetches and
  // its `default-src 'self'` CSP both resolve against cowswap.koeppelmann.dev. The
  // loopback upstream is read HERE, at BUILD time, and baked into the server bundle
  // — Next does not re-read it at runtime. So ORDERBOOK_UPSTREAM (and the viewer's
  // OB_PORT) must be set for `next build`; changing either in the runtime service
  // env without rebuilding silently points the proxy at the wrong port. Keep the
  // default port (8137) in sync with orderbook-viewer/run-prod.sh.
  async rewrites() {
    const upstream = process.env.ORDERBOOK_UPSTREAM || 'http://127.0.0.1:8137';
    return [
      { source: '/orderbook/:path*', destination: `${upstream}/:path*` },
    ];
  },
  async redirects() {
    // Enter at the explicit index.html so there is no directory-index redirect:
    // Next strips the trailing slash from `/orderbook/pro/` and the upstream then 301s
    // the bare directory to a prefix-less `/pro/` — a broken loop that 404s. Hitting
    // the file directly avoids that, and the viewer's relative asset/data fetches
    // still resolve against `/orderbook/pro/`. ('pro' is the viewer's single alias,
    // run.py ALIASES — the "CoW Swap Pro" rebrand.)
    const entry = '/orderbook/pro/index.html?token=stusds';
    return [
      { source: '/orderbook', destination: entry, permanent: false },
      { source: '/orderbook/pro', destination: entry, permanent: false },
    ];
  },
};
export default nextConfig;
