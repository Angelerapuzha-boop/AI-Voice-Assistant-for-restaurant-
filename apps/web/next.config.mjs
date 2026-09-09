/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@meatbox/core"],
  // The core package reaches outside the web app dir (monorepo).
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
};

export default nextConfig;
