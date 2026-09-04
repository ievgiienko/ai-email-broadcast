import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output keeps the Docker image small and self-contained.
  output: process.env.DOCKER_BUILD === "true" ? "standalone" : undefined,
  poweredByHeader: false,
  serverExternalPackages: ["postgres", "nodemailer"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // The tracking pixel is embedded in third-party mail clients, so it must
        // not inherit the frame/referrer restrictions above being interpreted as
        // a same-origin-only asset.
        source: "/api/track/open/:token",
        headers: [{ key: "X-Content-Type-Options", value: "nosniff" }],
      },
    ];
  },
};

export default nextConfig;
