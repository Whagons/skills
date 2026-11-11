import { reset } from "cloudflare:test";
import { afterEach } from "vitest";

// Every test starts from an empty vault.
afterEach(async () => {
  await reset();
});
