import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";
import { computeKernelClosure } from "../dist/kernel/segments/graph.js";

// ============================================================================
// Segment classification — role + applications field, validation rules,
// kernel-closure protection, default fall-through.
// See docs/1-design/3-accepted/00-ontology/segment-classification.md.
// ============================================================================

const bootHydrate = async (segments, manifests) => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, segments, manifests);
  return state;
};

const minimalSeg = (name) => ({ name, cels: [] });

test("default role: library when absent in manifest", async () => {
  const state = await bootHydrate(
    [minimalSeg("legacy")],
    [{ name: "legacy", version: "0.0.1", description: "no role declared", dependencies: [] }],
  );
  assert.equal(state.segments.get("legacy")?.role, "library");
});

test("explicit role preserved through hydrate", async () => {
  const state = await bootHydrate(
    [minimalSeg("my-app")],
    [{ name: "my-app", version: "0.0.1", description: "test", dependencies: [], role: "application" }],
  );
  assert.equal(state.segments.get("my-app")?.role, "application");
});

test("kernel role is derived from folder placement (not declared in 冊.json)", () => {
  // role left the seed JSON (roadmap 01/06): 冊.json carries no `role`
  // field; createInitialState stamps each bundled manifest's role from its
  // 甲骨坑/{kernel,library,application}/ folder (roleOf in src/index.ts).
  const state = createInitialState();
  assert.equal(state.segments.get("kernel")?.role, "kernel");
});

test("user-space without applications throws at validation", async () => {
  await assert.rejects(
    bootHydrate(
      [minimalSeg("doc-1")],
      [{ name: "doc-1", version: "0.0.1", description: "missing apps", dependencies: [], role: "user-space" }],
    ),
    /must declare `applications`/,
  );
});

test("user-space with applications targeting non-existent segment throws", async () => {
  await assert.rejects(
    bootHydrate(
      [minimalSeg("doc-2")],
      [{
        name: "doc-2", version: "0.0.1", description: "test", dependencies: [], role: "user-space",
        applications: ["never-defined-app"],
      }],
    ),
    /no such segment is installed/,
  );
});

test("user-space with applications targeting a library (wrong role) throws", async () => {
  await assert.rejects(
    bootHydrate(
      [minimalSeg("doc-3"), minimalSeg("not-an-app")],
      [
        { name: "not-an-app", version: "0.0.1", description: "test", dependencies: [], role: "library" },
        {
          name: "doc-3", version: "0.0.1", description: "test", dependencies: [], role: "user-space",
          applications: ["not-an-app"],
        },
      ],
    ),
    /role "library", not "application"/,
  );
});

test("library cannot depend on application", async () => {
  await assert.rejects(
    bootHydrate(
      [minimalSeg("my-app"), minimalSeg("bad-lib")],
      [
        { name: "my-app", version: "0.0.1", description: "test", dependencies: [], role: "application" },
        { name: "bad-lib", version: "0.0.1", description: "test", dependencies: ["my-app"], role: "library" },
      ],
    ),
    /\(library\) cannot depend on "my-app" \(application\)/,
  );
});

test("application cannot depend on user-space", async () => {
  await assert.rejects(
    bootHydrate(
      [minimalSeg("ufo"), minimalSeg("my-app")],
      [
        { name: "ufo", version: "0.0.1", description: "test", dependencies: [], role: "user-space",
          applications: ["my-app"] },
        { name: "my-app", version: "0.0.1", description: "test", dependencies: ["ufo"], role: "application" },
      ],
    ),
    /\(application\) cannot depend on "ufo" \(user-space\)/,
  );
});

test("valid user-space → application → library hydrates without error", async () => {
  const state = await bootHydrate(
    [minimalSeg("my-lib"), minimalSeg("my-app"), minimalSeg("doc-4")],
    [
      { name: "my-lib", version: "0.0.1", description: "test", dependencies: [], role: "library" },
      { name: "my-app", version: "0.0.1", description: "test", dependencies: ["my-lib"], role: "application" },
      { name: "doc-4",  version: "0.0.1", description: "test", dependencies: ["my-app"], role: "user-space",
        applications: ["my-app"] },
    ],
  );
  assert.equal(state.segments.get("doc-4")?.role, "user-space");
  assert.deepEqual(state.segments.get("doc-4")?.applications, ["my-app"]);
});

// ── Kernel-closure protection ──────────────────────────────────────────────

test("computeKernelClosure returns role:kernel + transitive deps", () => {
  const state = createInitialState();
  const closure = computeKernelClosure(state.segments);
  assert.ok(closure.has("kernel"), "kernel itself in closure");
  // Honest closure (roadmap 02): kernel.dependencies is [] and cel-error
  // folded into the kernel segment, so the closure is {kernel} alone.
  // Libraries are NO LONGER in the kernel closure — they dehydrate and
  // flush like any other segment.
  assert.equal(closure.size, 1, "closure is {kernel} alone");
  for (const lib of ["csp", "host", "builtins", "js-compiler", "file-store"]) {
    assert.ok(!closure.has(lib), `library "${lib}" must NOT be in kernel closure`);
  }
});

test("flush refuses the kernel segment; libraries flush freely", async () => {
  const state = createInitialState();
  const flush = resolveFn(state, "flush");
  // kernel itself is the only flush-protected segment now.
  await assert.rejects(
    flush(state, "kernel", { force: true }),
    /kernel closure/,
  );
  // builtins is an ordinary library: no longer kernel-protected, so a
  // forced flush succeeds and drops its cels.
  await flush(state, "builtins", { force: true });
  assert.ok(!state.cels.get("+"), "+ cel should be flushed away with builtins");
});

// ── Library applications-tag warning (advisory, not error) ─────────────────

test("library applications-tag mismatch with user-space emits warning, not error", async () => {
  const origWarn = console?.warn;
  let warned = false;
  if (console) {
    console.warn = (msg) => { if (typeof msg === "string" && msg.includes("classification warnings")) warned = true; };
  }
  try {
    await bootHydrate(
      [minimalSeg("notebook-lib"), minimalSeg("sheet-app"), minimalSeg("doc-5")],
      [
        // Library tagged for notebook, but used by spreadsheet user-space.
        { name: "notebook-lib", version: "0.0.1", description: "test", dependencies: [], role: "library",
          applications: ["notebook-app"] },
        { name: "sheet-app", version: "0.0.1", description: "test", dependencies: [], role: "application" },
        { name: "doc-5", version: "0.0.1", description: "test", dependencies: ["notebook-lib"], role: "user-space",
          applications: ["sheet-app"] },
      ],
    );
  } finally {
    if (console && origWarn) console.warn = origWarn;
  }
  assert.ok(warned, "should have emitted a console.warn about classification mismatch");
});
