import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// ============================================================================
// Import-direction rules for src/ — the layering contract:
//
//   types/  imports nothing from kernel/ or 甲骨坑/
//   kernel/ imports nothing from 甲骨坑/
//   甲骨坑/  reaches kernel/ and types/ ONLY through their index barrels
//           (intra-甲骨坑 imports are free)
//
// Placement encodes role; import direction is the DAG rule made visible.
// See docs/1-design/3-accepted/00-ontology/derived-activity-working-set.md
// "Source layout: 甲骨坑 mirrors the ontology".
// ============================================================================

const SRC = new URL("../src/", import.meta.url).pathname;

// Empty and must stay empty — the layering rules below admit no
// exceptions. (Roadmap 02 absorbed cel-error + nativeFn into the kernel
// proper, retiring the last debts that once lived here.)
const ALLOWLIST = [];

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
};

// import/export-from specifiers, including `import type` and bare imports.
const specifiersOf = (source) => {
  const out = [];
  const re = /(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) out.push(m[1] ?? m[2]);
  return out;
};

const allowed = (file, spec) =>
  ALLOWLIST.some((a) => a.file.test(file) && a.spec.test(spec));

const violations = { typesReach: [], kernelReach: [], deepReach: [] };

for (const abs of walk(SRC)) {
  const file = relative(SRC, abs);
  const specs = specifiersOf(readFileSync(abs, "utf8"));
  for (const spec of specs) {
    if (!spec.startsWith(".")) continue; // packages, bun:*, node:*
    if (allowed(file, spec)) continue;
    const entry = `${file} → ${spec}`;

    if (file.startsWith("types/") && (spec.includes("kernel/") || spec.includes("甲骨坑/"))) {
      violations.typesReach.push(entry);
    }
    if (file.startsWith("kernel/") && spec.includes("甲骨坑/")) {
      violations.kernelReach.push(entry);
    }
    if (file.startsWith("甲骨坑/")) {
      const escapesToKernel = spec.includes("kernel/");
      const escapesToTypes = spec.includes("types/");
      if (escapesToKernel && !spec.endsWith("kernel/index.js")) violations.deepReach.push(entry);
      if (escapesToTypes && !spec.endsWith("types/index.js")) violations.deepReach.push(entry);
    }
  }
}

test("types/ imports nothing from kernel/ or 甲骨坑/", () => {
  expect(violations.typesReach).toEqual([]);
});

test("kernel/ imports nothing from 甲骨坑/", () => {
  expect(violations.kernelReach).toEqual([]);
});

test("甲骨坑/ reaches kernel/ and types/ only via their index barrels", () => {
  expect(violations.deepReach).toEqual([]);
});
