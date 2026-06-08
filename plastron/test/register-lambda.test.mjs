import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

const boot = () => createInitialState();

test("registerLambda creates an EditableLambdaCel with metadata + _fn", async () => {
  const state = boot();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  await register(state, { key: "myFn", fn: (x) => x * 2, kind: "custom" });
  const cel = state.cels.get("myFn");
  assert.ok(cel, "cel missing");
  assert.equal(cel.celType, "EditableLambdaCel");
  assert.equal(cel.metadata.kind, "custom");
  assert.equal(typeof cel._fn, "function");
  assert.equal(resolveFn(state, "myFn")(5), 10, "resolveFn dispatches the registered fn");
});

test("registerLambda defaults segment to 'default'", async () => {
  const state = boot();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  await register(state, { key: "fn1", fn: () => 1 });
  assert.equal(state.cels.get("fn1").metadata.segment, "default");
});

test("registerLambda honors an explicit segment", async () => {
  const state = boot();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  await register(state, { key: "fn2", fn: () => 1, segment: "my-seg" });
  assert.equal(state.cels.get("fn2").metadata.segment, "my-seg");
});

test("locked registration creates a LockedLambdaCel", async () => {
  const state = boot();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  await register(state, { key: "lockedFn", fn: (x) => x + 1, locked: true });
  const cel = state.cels.get("lockedFn");
  assert.equal(cel.celType, "LockedLambdaCel");
  assert.equal(cel.locked, true);
});

test("re-register of an unlocked lambda replaces the cel; dispatch reflects the new impl", async () => {
  const state = boot();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  await register(state, { key: "fn3", fn: (x) => x * 2 });
  const ref = state.cels.get("fn3");
  await register(state, { key: "fn3", fn: (x) => x * 3 });
  assert.notEqual(state.cels.get("fn3"), ref, "replacement installs a fresh cel");
  assert.ok((state.cels.get("fn3")._defGen ?? 0) > 0, "definition generation stamped");
  assert.equal(resolveFn(state, "fn3")(5), 15, "fn dispatch should reflect the new impl");
});

test("re-register at a locked key throws", async () => {
  const state = boot();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  await assert.rejects(
    () => register(state, { key: "setValue", fn: () => 0 }),
    /is locked/,
  );
});

test("register over a non-lambda cel throws (kind mismatch)", async () => {
  const state = boot();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  // precomputedStates is a locked ValueCel; the locked guard fires first.
  await assert.rejects(
    () => register(state, { key: "precomputedStates", fn: () => 0 }),
    /is locked/,
  );
});

test("rejecting both fn and source", async () => {
  const state = boot();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  await assert.rejects(
    () => register(state, { key: "x", fn: () => 0, source: "..." }),
    /both fn and f/,
  );
});

test("rejecting neither fn nor source", async () => {
  const state = boot();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  await assert.rejects(
    () => register(state, { key: "x" }),
    /needs either fn or f/,
  );
});

test("metadata fields are carried through to cel.metadata", async () => {
  const state = boot();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  await register(state, {
    key: "rich",
    fn: (x) => x,
    kind: "custom",
    inputSchema: "number",
    outputSchema: "number",
  });
  const cel = state.cels.get("rich");
  assert.equal(cel.metadata.kind, "custom");
  assert.equal(cel.metadata.inputSchema, "number");
  assert.equal(cel.metadata.outputSchema, "number");
});
