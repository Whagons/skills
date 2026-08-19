import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Keep fonts as files: an inlined data: font would violate the
    // font-src 'self' policy in nginx.conf.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined),
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
