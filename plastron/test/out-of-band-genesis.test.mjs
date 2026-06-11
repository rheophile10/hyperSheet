import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// unify-commit-path (settleStructural): a generator (here =grid) fired by a
// VALUE change must materialize its cels WITHOUT any manual drain or user
// commit. Before the fix, an out-of-band generator enqueued genesis.commit but
// nothing drained it (the seam that hid =walletKeys). Now setValue settles it.
test("out-of-band genesis: a generator fired by setValue materializes (no manual drain)", async () => {
  const s = createInitialState();
  await resolveFn(s, "hydrate")(s, [{ name: "user", cels: [
    { key: "n", celType: "ValueCel", metadata: { key: "n", segment: "user" }, v: 2 },
    { key: "maker", celType: "FormulaCel", metadata: { key: "maker", segment: "user", parser: "infix" }, f: '=cels(n, 2, "gng")' },
  ]}], [{ name: "user", version: "0", description: "", dependencies: [] }]);

  const gngCount = () => [...s.cels.keys()].filter((k) => k.startsWith("gng.")).length;

  // A pure value change re-fires the generator. NO manual drain / commit.
  await resolveFn(s, "setValue")(s, "n", 3);
  assert.ok(gngCount() > 0, "the grid materialized via setValue alone — the seam is closed");
});

// view.refresh hook (sheet-host stage 1): settleStructural calls the host's
// "view.refresh" cel after out-of-band structure materializes, so the host can
// rebuild its rendered cell list (origin: 元.cells). #17 render half.
test("settleStructural fires the view.refresh hook on out-of-band materialization", async () => {
  const s = createInitialState();
  await resolveFn(s, "hydrate")(s, [{ name: "user", cels: [
    { key: "n", celType: "ValueCel", metadata: { key: "n", segment: "user" }, v: 2 },
    { key: "maker", celType: "FormulaCel", metadata: { key: "maker", segment: "user", parser: "infix" }, f: '=cels(n, 1, "gob")' },
  ]}], [{ name: "user", version: "0", description: "", dependencies: [] }]);
  let refreshed = 0;
  await resolveFn(s, "setCel")(s, "view.refresh", { celType: "LockedLambdaCel", fn: () => { refreshed++; }, metadata: { segment: "user", kind: "native" } });
  const r0 = refreshed;
  // out-of-band: a value change re-fires the generator → materializes → hook
  await resolveFn(s, "setValue")(s, "n", 3);
  assert.ok(refreshed > r0, "view.refresh fired when the out-of-band grid materialized");
});
