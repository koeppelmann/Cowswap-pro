/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // better-sqlite3 is a native module — don't bundle it into the server build.
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
};
export default nextConfig;
