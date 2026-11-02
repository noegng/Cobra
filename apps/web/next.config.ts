import path from "node:path";
import type { NextConfig } from "next";

// `pnpm --filter @cobra/web build` runs with cwd = apps/web; the workspace packages live two levels up.
const workspaceRoot = path.resolve(process.cwd(), "../..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages export raw TypeScript (no build step).
  transpilePackages: ["@cobra/shared", "@cobra/db", "@cobra/solver", "@cobra/bot"],
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // The payment page must never be framed (clickjacking of the sign button).
        source: "/pay/:path*",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
      {
        source: "/dashboard",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        source: "/.well-known/agent-registration.json",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
};

export default nextConfig;
