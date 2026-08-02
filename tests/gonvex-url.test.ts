import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withGonvexProject } from "../src/lib/gonvex-url.ts";

const productionRuntime = "gonvex-unified-prod.whagons.com";

test("routes the websocket to the synced Gonvex project", () => {
  assert.equal(
    withGonvexProject(`wss://${productionRuntime}/ws`, "skills"),
    `wss://${productionRuntime}/ws?project=skills`,
  );
});

test("all production runtime defaults use the unified Gonvex host", async () => {
  for (const path of [
    ".env.example",
    "Dockerfile",
    "gonvex.json",
    "nginx.conf",
    "src/App.tsx",
    "src/main.tsx",
    "cli/cmd/whagons-dev/main.go",
  ]) {
    const contents = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(contents, new RegExp(productionRuntime.replaceAll(".", "\\.")), path);
    assert.doesNotMatch(contents, /(?<!unified-prod\.)gonvex\.whagons\.com/, path);
  }
});
