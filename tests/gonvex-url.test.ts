import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withGonvexProject } from "../src/lib/gonvex-url.ts";

const productionRuntime = "gonvex.whagons.com";
const productionProject = "01f1974b-dcda-6fc3-b16d-9acf5f3b4192";

test("routes the websocket to the synced Gonvex project", () => {
  assert.equal(
    withGonvexProject(`wss://${productionRuntime}/ws`, productionProject),
    `wss://${productionRuntime}/ws?project=${productionProject}`,
  );
});

test("all runtime defaults use the production Gonvex host", async () => {
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
    if (path !== "nginx.conf") {
      assert.match(contents, new RegExp(productionProject), path);
    }
    if (path !== "cli/cmd/whagons-dev/main.go") {
      assert.doesNotMatch(contents, /gonvex-unified-dev\.whagons\.com/, path);
    }
  }
});
