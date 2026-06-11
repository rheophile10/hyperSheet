import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";

// ── Async runCycle re-entrancy race (kernel task #16) ───────────────────────
//
// runCascade does `await Promise.all(promises)` for ASYNC cels. That await is
// the one place the event loop can yield to a re-entrant trigger — a timer or
// event firing mid-cascade that calls setValue on the SAME state. Without a
// cycle queue, the re-entrant cascade interleaves with the outer one and a
// stale in-flight async result can land ON TOP of a newer committed value: a
// lost update.
//
// Topology:
//   a       — ValueCel; the input everyone reads.
//   slowB   — async lambda; snapshots a BEFORE awaiting (like a real Pyodide/
//             Javy round trip), then commits the snapshot.
//   fastC   — sync formula (+ a 0); tracks a immediately.
//
// Sequence we drive deterministically (no real timers):
//   1. setValue(a, 1) -> outer cascade fires slowB (snapshots a=1, parks) and
//      commits fastC=1.
//   2. While slowB is parked, fire a re-entrant setValue(a, 2) (a timer firing
//      mid-cascade). It sees the outer cascade in flight.
//   3. Async results resolve such that the STALE snapshot (a=1) lands LAST.
//
// We force "stale lands last" with a microtask-count gate: an invocation that
// snapshotted value V waits (3 - V) extra microtask turns before resolving, so
// the outer snapshot (1) always resolves after the re-entrant snapshot (2),
// regardless of which fires first. This is the worst-case interleave a real
// timer can produce; the kernel offers no ordering guarantee against it.
//
// CONSISTENCY INVARIANT (what a cycle queue must preserve): once everything
// quiesces, every consumer of `a` agrees on its latest value —
// slowB.v === fastC.v === a.v. A stale overwrite breaks it.
//
// This test is independent of HOW the fix orders things: under a cycle queue
// the re-entrant cascade is deferred until the outer drains and slowB then
// recomputes from the latest a, so the invariant holds. Under the buggy
// interleave it fails with slowB stuck at the stale snapshot.

const userManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

const register = (st, a) =>
  resolveFn(st, "setCel")(st, a.key, {
    celType: "LockedLambdaCel",
    locked: true,
    fn: a.fn,
    metadata: { segment: a.segment ?? "user", kind: a.kind },
  });

// Resolve after `turns` microtask hops — pure microtasks, fully deterministic.
const afterTurns = async (turns) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };

test("re-entrant setValue during an async cel's await must not leave a stale (lost) update", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const setValue = resolveFn(state, "setValue");

  await register(state, {
    key: "slow-id",
    fn: () => async (inputs) => {
      const snapshot = Number(inputs.a);   // capture BEFORE yielding
      // Force the STALE snapshot (a=1) to resolve LAST: it waits many microtask
      // turns; the newer snapshot (a=2) returns immediately. Worst case for the
      // lost-update race — the stale async result lands on top of the fresh one.
      await afterTurns(snapshot === 1 ? 8 : 0);
      return snapshot;
    },
    kind: "native",
  });

  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user" }, v: 0 },
      {
        key: "slowB",
        celType: "EditableLambdaCel",
        metadata: { key: "slowB", segment: "user", kind: "slow-id", inputMap: { a: "a" } },
        f: "",
      },
      {
        key: "fastC",
        celType: "FormulaCel",
        metadata: { key: "fastC", segment: "user" },
        f: "(+ a 0)",
      },
    ],
  };
  await hydrate(state, [seg], [userManifest]);
  await precomputeOptional(state);

  // 1. Outer write a = 1 (do NOT await — slowB is now parked mid-cascade).
  const outer = setValue(state, "a", 1);

  // 2. Yield one microtask so the outer cascade reaches slowB's await, then
  //    fire the re-entrant write a = 2 (a timer firing mid-cascade).
  await Promise.resolve();
  const reentrant = setValue(state, "a", 2);

  // 3. Let everything settle.
  await Promise.all([outer, reentrant]);

  const A = state.cels.get("a")?.v;
  const B = state.cels.get("slowB")?.v;
  const C = state.cels.get("fastC")?.v;

  assert.equal(A, 2, "a settled to its last write");
  assert.equal(C, 2, "fastC tracks the latest a");
  assert.equal(B, 2, `slowB must reflect the latest a (=2), not a stale snapshot; got ${B}`);
});
