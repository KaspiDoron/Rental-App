/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Cloud Run / Docker: emit a self-contained server (.next/standalone) with
  // only the traced node_modules, so the runtime image stays small and needs
  // no `npm install`. Vercel ignores this setting (it uses its own output),
  // so the same branch still deploys there unchanged.
  output: "standalone",
};

export default nextConfig;
