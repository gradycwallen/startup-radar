import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // This app lives inside the Startup Radar monorepo (repo root has its own package-lock.json for
  // the Scout backend). Pin the workspace root explicitly so Next.js/Turbopack never infers the
  // outer repo root and traces/watches the backend's files.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
