/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Cloud Run / Docker: emit a self-contained server (.next/standalone) with
  // only the traced node_modules, so the runtime image stays small and needs
  // no `npm install`. This is the deploy target - the root Dockerfile builds
  // this output into the Cloud Run web image.
  output: "standalone",
};

export default nextConfig;
