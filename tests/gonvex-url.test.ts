import assert from "node:assert/strict";
import test from "node:test";
import { withGonvexProject } from "../src/lib/gonvex-url.ts";

test("routes the websocket to the synced Gonvex project", () => {
  assert.equal(
    withGonvexProject("wss://gonvex.whagons.com/ws", "skills"),
    "wss://gonvex.whagons.com/ws?project=skills",
  );
});
