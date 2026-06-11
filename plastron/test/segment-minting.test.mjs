import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, resolveFn,
  canGet, canSet, hasDeclaredPolicy, bundleSegments,
} from "../dist/index.js";

// ============================================================================
// segment-minting (capability A) — a layer-named genesis mints a POLICIED
// segment (a closure). The genesis drain synthesizes a 访.<segment> policy:
// default public-get / private-set; a generator may DECLARE a sealed policy
// (the wallet pattern). Undeclared segments stay unrestricted, so this only
// adds closures — never breaks existing writers.
// ============================================================================

test("a layer-named genesis mints a default-policied segment", async () => {
  const state = createInitialState();
  await resolveFn(state, "setCel")(state, "makerGG", {
    celType: "FormulaCel", f: '(cels 2 2 "gg")',
    metadata: { key: "makerGG", segment: "origin", parser: "f" },
  });
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "genesis.commit");
  await resolveFn(state, "genesis.drain")([], state);

  assert.ok(hasDeclaredPolicy(state, "gg"), "minting synthesized 访.gg");
  assert.equal(canGet(state, "other", "gg"), true, "default get is public");
  assert.equal(canSet(state, "other", "gg"), false, "default set is private — a foreign segment cannot write gg");
  assert.equal(canSet(state, "gg", "gg"), true, "gg writes its own cels");
});

test("a generator can DECLARE a sealed policy (the wallet pattern); bundling can't widen a seal", async () => {
  const state = createInitialState();
  const gen = {
    metadata: { key: "sealMaker", segment: "origin" },
    v: {
      genesis: true, layer: "vault",
      access: { get: ["maker"], getSealed: true, set: "private" },
      cels: { "vault.key": { celType: "ValueCel", v: "s3cret", metadata: { name: "key" } } },
    },
  };
  state.cels.set("sealMaker", gen);
  await resolveFn(state, "genesis.drain")([{ cel: gen }], state);

  assert.ok(hasDeclaredPolicy(state, "vault"), "sealed segment minted a policy");
  assert.equal(canGet(state, "maker", "vault"), true, "the declared reader can get");
  assert.equal(canGet(state, "chat", "vault"), false, "anyone else is sealed out");
  bundleSegments(state, ["chat", "vault"]);
  assert.equal(canGet(state, "chat", "vault"), false, "bundling cannot widen a SEALED get");
});

test("composed segment(...) mints EACH part's segment (boot windows are closures)", async () => {
  const state = createInitialState();
  const gen = {
    metadata: { key: "compMaker", segment: "origin" },
    v: {
      genesis: true,
      mints: { "win.a": {}, "win.b": { get: ["maker"], getSealed: true, set: "private" } },
      cels: {
        "win.a.state": { celType: "ValueCel", v: 1, metadata: { segment: "win.a", name: "state" } },
        "win.b.state": { celType: "ValueCel", v: 2, metadata: { segment: "win.b", name: "state" } },
      },
    },
  };
  state.cels.set("compMaker", gen);
  await resolveFn(state, "genesis.drain")([{ cel: gen }], state);

  assert.ok(hasDeclaredPolicy(state, "win.a") && hasDeclaredPolicy(state, "win.b"), "both parts minted their own segment");
  assert.equal(canSet(state, "other", "win.a"), false, "win.a default private-set");
  assert.equal(canGet(state, "maker", "win.b"), true, "win.b sealed-get reader allowed");
  assert.equal(canGet(state, "win.a", "win.b"), false, "win.a (a sibling window) is sealed out of win.b");
});
