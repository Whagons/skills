import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import vectors from "./test/fixtures/go-vectors.json" with { type: "json" };

// Google's tokeninfo endpoint is replaced by a fake that accepts tokens of the
// form "fake|<sub>|<email>[|<aud>[|<email_verified>]]". Nothing leaves the
// machine during tests.
function fakeGoogle(request: Request): Response {
  const url = new URL(request.url);
  if (url.hostname !== "oauth2.googleapis.com") return new Response("blocked in tests", { status: 599 });
  const token = url.searchParams.get("id_token") ?? "";
  const [kind, sub, email, aud, verified] = token.split("|");
  if (kind !== "fake") return new Response("{}", { status: 400 });
  return Response.json({
    sub, email, name: email?.split("@")[0] ?? "", email_verified: verified ?? "true",
    aud: aud || "578623964983-iall0oeq2r2mke7trpqqv3pjingqljh0.apps.googleusercontent.com",
  });
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SKILLS_SECRET_KEY: vectors.key,
          SKILLS_ALLOWED_EMAILS: "owner@fixtures.invalid,second-owner@fixtures.invalid",
          ADMIN_TOKEN: "test-admin-token-0123456789abcdef0123456789abcdef",
        },
        outboundService: fakeGoogle,
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
});
