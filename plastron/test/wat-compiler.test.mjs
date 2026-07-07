import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// ── boot ────────────────────────────────────────────────────────────────────

test("wat-compiler segment seeds the 'wat' compiler cel", () => {
  const state = createInitialState();
  const watCel = state.cels.get("wat");
  assert.ok(watCel, "wat compiler cel missing");
  assert.equal(watCel.locked, true, "wat compiler cel should be locked");
});

// ── compile + run via registerLambda ────────────────────────────────────────

const SIMPLE_ADD_WAT = `
  (module
    (func (export "main") (param $a i32) (param $b i32) (result i32)
      local.get $a
      local.get $b
      i32.add))
`;

test("WAT source compiles into a callable Fn (i32 + i32)", async () => {
  const state = createInitialState();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  await register(state, { key: "adder", source: SIMPLE_ADD_WAT, kind: "wat" });

  const adder = resolveFn(state, "adder");
  assert.equal(typeof adder, "function", "adder should resolve to a function");
  assert.equal(adder(2, 3), 5);
  assert.equal(adder(-1, 1), 0);
  assert.equal(adder(2147483647, 1), -2147483648); // i32 wrap
});

// ── single-export fallback ──────────────────────────────────────────────────

test("WAT module with one non-main export uses it as the entry", async () => {
  const state = createInitialState();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  const src = `
    (module
      (func (export "negate") (param $x i32) (result i32)
        i32.const 0 local.get $x i32.sub))
  `;
  await register(state, { key: "neg", source: src, kind: "wat" });
  const neg = resolveFn(state, "neg");
  assert.equal(neg(7), -7);
  assert.equal(neg(-3), 3);
});

// ── multiple-exports error ──────────────────────────────────────────────────

test("WAT module with multiple exports and no 'main' throws a clear error", async () => {
  const state = createInitialState();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  const src = `
    (module
      (func (export "a") (result i32) i32.const 1)
      (func (export "b") (result i32) i32.const 2))
  `;
  await assert.rejects(
    () => register(state, { key: "multi", source: src, kind: "wat" }),
    /multiple functions/i,
  );
});

// ── prefers 'main' over other exports ───────────────────────────────────────

test("when 'main' exists alongside other exports, it is selected", async () => {
  const state = createInitialState();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  const src = `
    (module
      (func (export "helper") (result i32) i32.const 99)
      (func (export "main") (result i32) i32.const 42))
  `;
  await register(state, { key: "picks-main", source: src, kind: "wat" });
  const fn = resolveFn(state, "picks-main");
  assert.equal(fn(), 42);
});

// ── f64 entry-point ─────────────────────────────────────────────────────────

test("WAT module with f64 args returns JS numbers transparently", async () => {
  const state = createInitialState();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  const src = `
    (module
      (func (export "main") (param $x f64) (param $y f64) (result f64)
        local.get $x local.get $y f64.mul))
  `;
  await register(state, { key: "mul", source: src, kind: "wat" });
  const mul = resolveFn(state, "mul");
  assert.equal(mul(2.5, 4), 10);
  assert.equal(mul(0.1, 0.2), 0.1 * 0.2); // float identity
});

// ── csp gate ────────────────────────────────────────────────────────────────

test("forcing csp.wasm-available = false makes the WAT compiler throw a CSP-aware message", async () => {
  const state = createInitialState();
  state.cels.set("csp.wasm-available", {
    ...state.cels.get("csp.wasm-available"), v: false,
  });
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  await assert.rejects(
    () => register(state, { key: "should-fail", source: SIMPLE_ADD_WAT, kind: "wat" }),
    /csp\.wasm-available = false|WebAssembly is unavailable/i,
  );
});

// ── host-instance hook: a memory-owning WAT module hands over its instance ───
//
// The native change NanoSteg needs: parity with wasm-bytes' onInstantiate /
// metadata.imports / metadata.wasmExport hook, but for WAT *source* on the
// sheet. A module that (export "memory") + several functions, with a
// metadata.imports provider, must hand its LIVE instance (memory + every
// export) to onInstantiate — the same contract wasm-host-instance.test.mjs
// proves for the bytes loader.

const MEM_MODULE_WAT = `
  (module
    (import "env" "peek" (func $peek (result i32)))
    (memory (export "memory") 1)
    (func (export "init") i32.const 0 i32.const 42 i32.store)
    (func (export "tick") (result i32) call $peek))
`;

test("onInstantiate hands a WAT module's live instance to the provider (memory + multi-export)", async () => {
  const state = createInitialState();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, wasmExport: a.wasmExport, imports: a.imports } }));
  const hydrate = resolveFn(state, "hydrate");

  let captured = null;
  let onInstantiateCalls = 0;
  const mem = { view: null };
  await register(state, {
    key: "wat-host-provider",
    fn: () => ({
      imports: { env: { peek: () => mem.view.getInt32(0, true) } },
      onInstantiate: (instance) => {
        onInstantiateCalls++;
        captured = instance;
        mem.view = new DataView(instance.exports.memory.buffer);
      },
    }),
  });

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "watmem", celType: "EditableLambdaCel",
        metadata: { key: "watmem", segment: "user", kind: "wat",
                    wasmExport: "init", imports: "wat-host-provider" },
        f: MEM_MODULE_WAT },
    ],
  }], [{ name: "user", version: "0.0.1", description: "test", dependencies: [] }]);

  assert.equal(onInstantiateCalls, 1, "onInstantiate should fire exactly once");
  assert.ok(captured, "host should have captured the WAT instance");
  assert.equal(typeof captured.exports.init, "function");
  assert.equal(typeof captured.exports.tick, "function");
  assert.ok(captured.exports.memory?.buffer instanceof ArrayBuffer, "exported memory reachable");

  // The host drives the instance directly: multiple exports + live memory.
  captured.exports.init();                    // memory[0] = 42
  assert.equal(captured.exports.tick(), 42);  // tick → env.peek → reads memory[0]
});

test("a WAT module with multiple exports selects metadata.wasmExport", async () => {
  const state = createInitialState();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: "EditableLambdaCel", locked: false, f: a.source, metadata: { segment: "user", kind: "wat", wasmExport: a.wasmExport } }));
  const src = `
    (module
      (func (export "a") (result i32) i32.const 1)
      (func (export "b") (result i32) i32.const 2))
  `;
  await register(state, { key: "picksB", source: src, wasmExport: "b" });
  const fn = resolveFn(state, "picksB");
  assert.equal(fn(), 2, "wasmExport 'b' should be the selected entry");
});

// ── malformed WAT errors ────────────────────────────────────────────────────

test("syntactically invalid WAT throws from wabt with a usable error", async () => {
  const state = createInitialState();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  await assert.rejects(
    () => register(state, {
      key: "broken",
      source: "(module (func not-a-real-instr))",
      kind: "wat",
    }),
  );
});
