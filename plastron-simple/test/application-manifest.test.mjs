import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, resolveFn, getPrecomputedIndexes, dormantSegmentOf,
  hydrate函, dehydrate函, isSegmentPending,
} from "../dist/index.js";

// ============================================================================
// 函 — the application artifact (design phase 4 / roadmap 06).
//
// 函 = version + per-segment payload sources (inline | url | store | codeSeed)
//      + a boot record { wake: [roots], set: [[key, value], …] }.
// hydrate函 installs entries dormant/codeSeed, wakes the boot roots, applies
// boot.set. dehydrate函 emits the single artifact for warm boot.
//
// Design: docs/1-design/3-accepted/00-ontology/derived-activity-working-set.md
// ============================================================================

const dval = (key, seg, v) => ({ key, celType: "ValueCel", metadata: { key, segment: seg }, v });
const dformula = (key, seg, f, inputMap = {}) => ({
  key, celType: "FormulaCel",
  metadata: { key, segment: seg, parser: "f", inputMap },
  f,
});

// ── inline payload source ─────────────────────────────────────────────────────

test("hydrate函: inline entries install dormant; boot.wake inflates the root + its closure", async () => {
  const state = createInitialState();
  const app = {
    version: "0.1.0",
    boot: { wake: ["doc"], set: [["doc.n", 10]] },
    segments: [
      {
        name: "doc",
        payload: { inline: { name: "doc", cels: [
          dval("doc.n", "doc", 3),
          dformula("doc.dbl", "doc", "(* doc.n 2)", { "doc.n": "doc.n" }),
        ] } },
        manifest: { dependencies: ["builtins"], role: "application" },
      },
    ],
  };
  await hydrate函(state, app);
  const getCel = resolveFn(state, "getCel");
  // doc woke (root) — live cels present, and doc.n took boot.set's 10,
  // doc.dbl recomputed to 20.
  assert.equal(state.cels.has("doc.n"), true, "doc woke");
  assert.equal(getCel(state, "doc.n").v, 10, "boot.set applied");
  assert.equal(getCel(state, "doc.dbl").v, 20, "formula recomputed against set value");
});

test("hydrate函: an inline entry NOT in boot.wake stays dormant (readable, inert)", async () => {
  const state = createInitialState();
  const app = {
    version: "0.1.0",
    boot: { wake: [] },
    segments: [
      {
        name: "doc",
        payload: { inline: { name: "doc", cels: [dval("doc.n", "doc", 7)] } },
        manifest: { role: "application" },
      },
    ],
  };
  await hydrate函(state, app);
  assert.equal(state.cels.has("doc.n"), false, "no live cel — dormant");
  assert.equal(dormantSegmentOf(state, "doc.n"), "doc", "dormant index sees it");
  assert.equal(resolveFn(state, "getCel")(state, "doc.n").v, 7, "dormant read returns dehydrated v");
});

// ── boot.set against a not-woken segment THROWS (dormant write) ────────────────

test("hydrate函: boot.set to a cel in a segment boot.wake didn't wake throws (dormant write)", async () => {
  const state = createInitialState();
  const app = {
    version: "0.1.0",
    boot: { wake: [], set: [["doc.n", 99]] },
    segments: [
      {
        name: "doc",
        payload: { inline: { name: "doc", cels: [dval("doc.n", "doc", 1)] } },
        manifest: { role: "application" },
      },
    ],
  };
  await assert.rejects(() => hydrate函(state, app), /DORMANT segment "doc"|wake/);
});

// ── codeSeed source ───────────────────────────────────────────────────────────

test("hydrate函: codeSeed entry whose loader exists installs; in boot.wake ⇒ eager, else parked", async () => {
  const state = createInitialState({ lazy: ["sound"] });
  // 'sound' is a real bundled segment; createInitialState({lazy}) parked it.
  // A 函 that codeSeeds it and wakes it should make it live.
  assert.equal(isSegmentPending(state, "sound"), true, "parked by lazy");
  const app = {
    version: "0.1.0",
    boot: { wake: ["sound"] },
    segments: [{ name: "sound", payload: { codeSeed: true } }],
  };
  await hydrate函(state, app);
  assert.equal(state.cels.has("sound.play-tone"), true, "codeSeed woke → live cels");
});

test("hydrate函: a codeSeed with NO bundled loader fails at 函-hydrate, before anything installs", async () => {
  const state = createInitialState();
  const app = {
    version: "0.1.0",
    boot: { wake: ["ghost"] },
    segments: [{ name: "ghost", payload: { codeSeed: true }, manifest: { role: "application" } }],
  };
  await assert.rejects(() => hydrate函(state, app), /codeSeed but no bundled loader/);
  // Nothing installed — the manifest never landed.
  assert.equal(state.cels.has("冊.ghost"), false, "no SegmentCel — failed before install");
});

// ── url source (fetch stub) ───────────────────────────────────────────────────

test("hydrate函: url source resolves on FIRST WAKE via fetch", async () => {
  const state = createInitialState();
  const payload = { name: "remote", cels: [dval("remote.x", "remote", 42)] };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "./remote.甲", "fetched the declared url");
    return { ok: true, status: 200, statusText: "OK", json: async () => payload };
  };
  try {
    const app = {
      version: "0.1.0",
      boot: { wake: ["remote"] },
      segments: [{ name: "remote", payload: { url: "./remote.甲" }, manifest: { role: "application" } }],
    };
    await hydrate函(state, app);
    assert.equal(state.cels.get("remote.x")?.v, 42, "url payload woke into live cels");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("hydrate函: url source NOT in boot.wake stays a pending dormant segment (no fetch yet)", async () => {
  const state = createInitialState();
  let fetched = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const app = {
      version: "0.1.0",
      boot: { wake: [] },
      segments: [{ name: "remote", payload: { url: "./remote.甲" }, manifest: { role: "application" } }],
    };
    await hydrate函(state, app);
    assert.equal(fetched, false, "no fetch until first wake");
    assert.equal(state.cels.has("冊.remote"), true, "SegmentCel present");
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── store source (store.get overridden on the cel) ────────────────────────────

test("hydrate函: store source resolves on first wake via store.get", async () => {
  const state = createInitialState();
  // Override the bundled store.get's _fn to serve a payload without disk.
  // store.get is a module-level shared cel across createInitialState calls,
  // so restore _fn afterward or other suites see the stub.
  const getCelObj = state.cels.get("store.get");
  const origGet = getCelObj._fn;
  const payload = { name: "stored", cels: [dval("stored.y", "stored", 5)] };
  getCelObj._fn = async (_st, name) => {
    assert.equal(name, "stored");
    return { manifest: { name: "stored", version: "1.0.0", dependencies: [], role: "application" }, segment: payload };
  };
  try {
    const app = {
      version: "0.1.0",
      boot: { wake: ["stored"] },
      segments: [{ name: "stored", payload: { store: { name: "stored" } }, manifest: { role: "application" } }],
    };
    await hydrate函(state, app);
    assert.equal(state.cels.get("stored.y")?.v, 5, "store payload woke into live cels");
  } finally {
    getCelObj._fn = origGet;
  }
});

// ── 函 nesting refusal (DECIDED v1: no nesting) ────────────────────────────────

test("wake: a url source that resolves to another 函 is refused (no nesting in v1)", async () => {
  const state = createInitialState();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ version: "0.1.0", boot: { wake: [] }, segments: [] }),
  });
  try {
    const app = {
      version: "0.1.0",
      boot: { wake: ["nested"] },
      segments: [{ name: "nested", payload: { url: "./nested.甲" }, manifest: { role: "application" } }],
    };
    await assert.rejects(() => hydrate函(state, app), /nesting is unsupported|resolved to a 函/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── warm boot: dehydrate函 → hydrate函 round-trip ──────────────────────────────

test("dehydrate函: round-trips the awake/dormant split + values", async () => {
  const state = createInitialState();
  // Two inline segments: 'base' (a dep) + 'doc' (depends on base via a cel
  // edge). Wake doc → base wakes too (closure). Then sleep nothing — both awake.
  const app = {
    version: "0.2.0",
    boot: { wake: ["doc"], set: [["doc.n", 4]] },
    segments: [
      {
        name: "base",
        payload: { inline: { name: "base", cels: [dval("base.k", "base", 100)] } },
        manifest: { role: "library" },
      },
      {
        name: "doc",
        payload: { inline: { name: "doc", cels: [
          dval("doc.n", "doc", 1),
          dformula("doc.sum", "doc", "(+ doc.n base.k)", { "doc.n": "doc.n", "base.k": "base.k" }),
        ] } },
        manifest: { dependencies: ["base", "builtins"], role: "application" },
      },
    ],
  };
  await hydrate函(state, app);
  const getCel = resolveFn(state, "getCel");
  assert.equal(getCel(state, "doc.sum").v, 104, "doc.n(4) + base.k(100)");

  // Sleep 'doc' so the round-trip exercises both an awake (base) and a
  // dormant (doc) segment.
  await resolveFn(state, "sleep")(state, "doc");
  assert.equal(state.cels.has("doc.n"), false, "doc now dormant");
  assert.equal(state.cels.has("base.k"), true, "base still awake");

  // dehydrate函 → fresh state → hydrate函.
  const artifact = dehydrate函(state, { version: "0.2.0" });
  assert.equal(artifact.version, "0.2.0");
  // boot.wake names the awake root cover. 'base' is awake; 'doc' is dormant
  // (not awake), so the only awake non-kernel root is 'base'.
  assert.ok(artifact.boot.wake.includes("base"), "base is an awake root");
  assert.ok(!artifact.boot.wake.includes("doc"), "doc is dormant, not a boot root");
  // No set pairs — values ride in the payloads.
  assert.ok(!artifact.boot.set || artifact.boot.set.length === 0, "no set pairs in warm boot");

  const fresh = createInitialState();
  await hydrate函(fresh, artifact);
  const fGet = resolveFn(fresh, "getCel");
  // Same split: base awake, doc dormant; same values.
  assert.equal(fresh.cels.has("base.k"), true, "base awake after round-trip");
  assert.equal(fGet(fresh, "base.k").v, 100, "base value preserved");
  assert.equal(dormantSegmentOf(fresh, "doc.n"), "doc", "doc still dormant after round-trip");
  assert.equal(fGet(fresh, "doc.n").v, 4, "doc.n dormant value preserved (the 4 from boot.set)");

  // Waking doc in the fresh state recomputes the formula → same 104.
  await resolveFn(fresh, "wake")(fresh, "doc");
  assert.equal(fGet(fresh, "doc.sum").v, 104, "woken formula recomputes to the same value");
});

// ── dehydrate函: bundled segments emit as codeSeed, kernel excluded ────────────

test("dehydrate函: bundled libraries emit as codeSeed; kernel is excluded", async () => {
  const state = createInitialState();
  const artifact = dehydrate函(state);
  const byName = new Map(artifact.segments.map((s) => [s.name, s]));
  // A representative bundled library → codeSeed.
  assert.ok(byName.has("builtins"), "builtins present");
  assert.deepEqual(byName.get("builtins").payload, { codeSeed: true }, "bundled ⇒ codeSeed");
  // Kernel never appears (re-seeds at createInitialState).
  assert.equal(byName.has("kernel"), false, "kernel excluded from the artifact");
  // The eager default makes every bundled library an awake root candidate;
  // boot.wake is non-empty and names library roots.
  assert.ok(artifact.boot.wake.length > 0, "warm boot names awake roots");
});
