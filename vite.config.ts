import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The data layer is chosen at build time. The default (Docker/Coolify) build
// keeps the Gonvex client; `vite build --mode cloudflare` builds the UI for
// the Worker (worker/, docs/cloudflare/DESIGN.md).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@backend": mode === "cloudflare" ? "/src/backend/cloudflare.tsx" : "/src/backend/gonvex.tsx",
    },
  },
  build: {
    // Keep fonts as files: an inlined data: font would violate the
    // font-src 'self' policy in nginx.conf.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined),
  },
  server: {
    port: 5174,
    strictPort: true,
  },
}));
