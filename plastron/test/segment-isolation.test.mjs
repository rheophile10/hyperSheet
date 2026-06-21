import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { createInitialState, resolveFn } from "../dist/index.js";

// ============================================================================
// Segment isolation ratchet (docs/1-design/2-in-evaluation/segment-isolation.md)
//
// 1. No segment folder's TypeScript may import a SIBLING segment at
//    runtime. Platform imports (src/types, src/kernel) and intra-segment
//    imports are the only outward edges allowed; `import type` is erased
//    and exempt everywhere.
// 2. Derive-don't-declare: every cel key a segment consumes via a
//    resolveFn/cels.get STRING LITERAL must resolve in a booted state
//    (or be seeded by the segment itself / listed as dynamic below).
// ============================================================================

const ROOT = new URL("../src/甲骨坑/", import.meta.url).pathname;
const GROUPS = ["library", "application", "kernel"];

const tsFiles = (dir) => {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
};

const segments = [];
for (const g of GROUPS) {
  const gdir = join(ROOT, g);
  let entries = [];
  try { entries = readdirSync(gdir); } catch { continue; }
  if (g === "kernel") { segments.push({ name: "kernel/kernel", dir: gdir }); continue; }
  for (const e of entries) {
    const p = join(gdir, e);
    if (statSync(p).isDirectory()) segments.push({ name: `${g}/${e}`, dir: p });
  }
}

const IMPORT_RE = /(import|export)\s+[^"';]*?from\s+["']([^"']+)["']/gs;

test("ratchet: zero runtime imports from sibling segments", () => {
  const violations = [];
  for (const seg of segments) {
    for (const file of tsFiles(seg.dir)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(IMPORT_RE)) {
        const stmt = m[0];
        const spec = m[2];
        if (!spec.startsWith(".")) continue;                 // npm/runtime deps
        if (/^\s*(import|export)\s+type\b/.test(stmt)) continue; // erased
        const target = normalize(join(file, "..", spec));
        if (target.startsWith(seg.dir + sep)) continue;      // intra-segment
        if (target.includes(`${sep}src${sep}types`) || target.includes(`${sep}src${sep}kernel`)) continue; // platform
        violations.push(`${seg.name}: ${file.slice(ROOT.length)} → ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, [], `sibling-segment runtime imports:\n${violations.join("\n")}`);
});

// Literal cel keys a segment consumes. Two shapes cover the codebase:
//   resolveFn(<expr>, "key")     and     state.cels.get("key")
const KEY_RE = /resolveFn\([^,]+,\s*"([^"]+)"\)|\.cels\.get\(\s*"([^"]+)"\s*\)/g;

// Keys that are legitimately absent in a bare boot (host/app supplied,
// or written later at runtime).
const DYNAMIC_OK = new Set([
]);

test("derive-don't-declare: every literal consumed key resolves in a booted state", () => {
  const state = createInitialState();
  const missing = [];
  for (const seg of segments) {
    for (const file of tsFiles(seg.dir)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(KEY_RE)) {
        const key = m[1] ?? m[2];
        if (DYNAMIC_OK.has(key)) continue;
        if (!state.cels.has(key)) missing.push(`${seg.name}: "${key}" (${file.slice(ROOT.length)})`);
      }
    }
  }
  assert.deepEqual(missing, [], `consumed keys that don't resolve at boot:\n${missing.join("\n")}`);
});

test("the cel-mediated remediations resolve and dispatch", async () => {
  const state = createInitialState();
  // class B: host.imports
  const hostImports = resolveFn(state, "host.imports");
  assert.equal(typeof hostImports, "function");
  const ns = hostImports(state);
  assert.equal(typeof ns.log, "function");
  assert.equal(typeof ns.now, "function");
  // class C: store surface incl. the new raw cels
  for (const k of ["store.putRaw", "store.readIndex", "store.root"]) {
    assert.ok(state.cels.get(k), `${k} missing`);
  }
  assert.equal(state.cels.get("store.root").v, "plastron");
  // class D: comparator cels
  const eq = resolveFn(state, "vnode.equals");
  assert.equal(typeof eq, "function");
  assert.equal(eq({ type: "text", text: "x" }, { type: "text", text: "x" }), true);
  assert.equal(eq({ type: "text", text: "x" }, { type: "text", text: "y" }), false);
});
