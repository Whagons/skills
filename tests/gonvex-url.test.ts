import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withGonvexProject } from "../src/lib/gonvex-url.ts";

const developmentRuntime = "gonvex-unified-dev.whagons.com";

test("routes the websocket to the synced Gonvex project", () => {
  assert.equal(
    withGonvexProject(`wss://${developmentRuntime}/ws`, "skills"),
    `wss://${developmentRuntime}/ws?project=skills`,
  );
});

test("all runtime defaults use the unified development Gonvex host", async () => {
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
    assert.match(contents, new RegExp(developmentRuntime.replaceAll(".", "\\.")), path);
    assert.doesNotMatch(contents, /gonvex-unified-prod\.whagons\.com/, path);
  }
});
