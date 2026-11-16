import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every page is signed-in and live, so the classic fully dynamic model fits best.
  transpilePackages: ["@openstaff/core"],
  outputFileTracingRoot: path.join(__dirname, "../../"),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
