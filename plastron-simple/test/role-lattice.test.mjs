import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Role-lattice dependency rules for the 冊 seed — the manifest-level twin
// of import-direction.test.mjs. Where that test guards module edges, this
// one guards declared SEGMENT edges:
//
//   role is derived from folder placement:
//     甲骨坑/kernel/           → "kernel"  (flat — the kernel role admits
//                                          exactly one segment by rule, so
//                                          kernel/ IS the segment folder)
//     甲骨坑/library/<seg>/     → "library"
//     甲骨坑/application/<seg>/ → "application"
//
//   no kernel segment depends on a library or application segment;
//   no library segment depends on an application segment.
//
// A segment can't claim a dependency its layer forbids even when no
// import would catch it. See docs/1-design/3-accepted/00-ontology/
// derived-activity-working-set.md "Source layout".
// ============================================================================

const KENG = decodeURIComponent(new URL("../src/甲骨坑/", import.meta.url).pathname);

const ROLES = ["kernel", "library", "application"];
const RANK = { kernel: 0, library: 1, application: 2 };

// Walk 甲骨坑/{kernel,library,application}/<segment>/ → role map (folder = role).
// Special case: the kernel role admits exactly one segment by rule, so
// kernel/ is FLAT — it IS the "kernel" segment folder, not a directory of
// segment folders. library/ and application/ hold one subdir per segment.
const roleByName = new Map();
roleByName.set("kernel", "kernel");
for (const role of ["library", "application"]) {
  const dir = join(KENG, role);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) roleByName.set(e.name, role);
  }
}

const seed = JSON.parse(readFileSync(join(KENG, "冊.json"), "utf8"));

// Empty and must stay empty — the role lattice admits no exceptions.
// (Roadmap 02 shrank the kernel manifest's dependencies to [], retiring
// the kernel→library edges that once lived here.)
const ALLOWLIST = [];

const allowed = (from, to) =>
  ALLOWLIST.some((a) => a.from === from && (a.to === undefined || a.to === to));

const violations = [];
for (const m of seed) {
  const fromRole = roleByName.get(m.name);
  // Every manifest in 冊 must have a folder (hence a derived role).
  if (!fromRole) {
    violations.push(`${m.name} → (no role folder in 甲骨坑/{kernel,library,application}/)`);
    continue;
  }
  for (const dep of m.dependencies ?? []) {
    const toRole = roleByName.get(dep);
    if (!toRole) {
      violations.push(`${m.name} (${fromRole}) → ${dep} (unknown segment, no role folder)`);
      continue;
    }
    // Edge legal only when the dependency is at or below the depender's
    // layer: kernel→kernel; library→{kernel,library}; app→anything.
    if (RANK[toRole] > RANK[fromRole] && !allowed(m.name, dep)) {
      violations.push(`${m.name} (${fromRole}) → ${dep} (${toRole})`);
    }
  }
}

test("every 冊 manifest has a role folder under 甲骨坑/{kernel,library,application}/", () => {
  const orphans = seed
    .filter((m) => !roleByName.has(m.name))
    .map((m) => m.name);
  expect(orphans).toEqual([]);
});

test("kernel depends only on kernel; library never depends on application", () => {
  expect(violations).toEqual([]);
});
