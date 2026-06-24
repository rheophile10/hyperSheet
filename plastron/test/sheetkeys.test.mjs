import { test } from "bun:test";
import assert from "node:assert/strict";

// sheetkeys.hash — deterministic SHA-256 of a segment's SOURCE cels (Phase 2B).
// Sources only: a FormulaCel hashes its TEXT, not its derived value; a ValueCel
// hashes its literal. Exclusions drop ranges. Same sources ⇒ same hash anywhere.
const { createInitialState, precomputeOptional, resolveFn } = await import("../dist/index.js");

const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["sheetkeys"]);
  await resolveFn(s, "hydrate")(s, [], []);
  await precomputeOptional(s);
  return s;
};
const put = (s, k, spec) => resolveFn(s, "setCel")(s, k, { metadata: { key: k, segment: k.split(".")[0] }, ...spec });
const H = (s, seg, ex) => resolveFn(s, "sheetkeys.hash")(s, seg, ex);

test("hash is a 64-hex SHA-256 over a segment's source cels, stable + order-independent", async () => {
  const s = await boot();
  await put(s, "foo.A1", { celType: "ValueCel", v: 5 });
  await put(s, "foo.B2", { celType: "ValueCel", v: "hi" });
  const h1 = await H(s, "foo");
  assert.match(h1, /^[0-9a-f]{64}$/, "64-hex digest");
  // re-hash same state → identical
  assert.equal(await H(s, "foo"), h1, "deterministic");
  // a fresh state with the SAME sources (inserted in a different order) → same hash
  const s2 = await boot();
  await put(s2, "foo.B2", { celType: "ValueCel", v: "hi" });
  await put(s2, "foo.A1", { celType: "ValueCel", v: 5 });
  assert.equal(await H(s2, "foo"), h1, "order-independent: sorted by key");
});

test("changing a SOURCE changes the hash; a FormulaCel hashes its TEXT not its value", async () => {
  const s = await boot();
  await put(s, "g.A1", { celType: "ValueCel", v: 1 });
  await put(s, "g.A2", { celType: "FormulaCel", f: "=g.A1*2", v: 2 });
  const before = await H(s, "g");
  // mutate only the DERIVED value of the formula cell (not its .f) → SAME hash
  await put(s, "g.A2", { celType: "FormulaCel", f: "=g.A1*2", v: 999 });
  assert.equal(await H(s, "g"), before, "derived value is NOT part of the hash (sources only)");
  // change the formula TEXT → hash changes
  await put(s, "g.A2", { celType: "FormulaCel", f: "=g.A1*3", v: 999 });
  assert.notEqual(await H(s, "g"), before, "formula text IS a source");
  // change a value source → hash changes
  await put(s, "g.A2", { celType: "FormulaCel", f: "=g.A1*2", v: 2 });
  const base = await H(s, "g");
  await put(s, "g.A1", { celType: "ValueCel", v: 7 });
  assert.notEqual(await H(s, "g"), base, "value source change shifts the hash");
});

test("exclude patterns drop ranges (exact + trailing-* prefix)", async () => {
  const s = await boot();
  await put(s, "x.A1", { celType: "ValueCel", v: 1 });
  await put(s, "x.live", { celType: "ValueCel", v: 111 });
  await put(s, "x.live2", { celType: "ValueCel", v: 222 });
  const full = await H(s, "x");
  assert.notEqual(await H(s, "x", ["x.live*"]), full, "excluding a range changes the hash");
  // excluding the live range == a state without those cels
  const s2 = await boot();
  await put(s2, "x.A1", { celType: "ValueCel", v: 1 });
  assert.equal(await H(s, "x", ["x.live*"]), await H(s2, "x"), "exclude(live*) ≡ absent");
  // comma-string form works too
  assert.equal(await H(s, "x", "x.live,x.live2"), await H(s2, "x"), "comma-string exclude");
});

test("hash of an empty/unknown segment is the empty-set digest, and '' for no seg", async () => {
  const s = await boot();
  assert.equal(await H(s, ""), "", "no segment → empty string");
  assert.match(await H(s, "nope"), /^[0-9a-f]{64}$/, "unknown segment → digest of nothing (still 64-hex)");
});
