#!/usr/bin/env bun
// ============================================================================
// verb-call-graph.mjs — derive the verb-level call graph from the 甲骨坑
// sources and emit it as a data value the origin app can import like a seed.
//
// GENERATED, NOT DECLARED: edges live in code (resolveFn targets, dispatch
// strings, seed `on` handlers, channel drain/dispose keys, emitsTo routing),
// so the graph is rebuilt from the code on every build rather than hand-kept
// in metadata where it would drift.
//
// Edge kinds:
//   resolveFn — a native fn body resolves another verb by key:
//               resolveFn(state|st|s, "X")
//   dispatch  — a vnode handler names a verb: dispatch: "X" in TS, or a seed
//               formula's (on "ev" "X" …) / on("ev","X") / on('ev','X')
//   drain     — a ChannelCel's v.drain / v.dispose key
//   emits     — metadata.emitsTo (compilers route the verb's effect calls to
//               that channel — kernel/卜/formula.ts + sheet/utils/infix.ts)
//
// Caller attribution inside a segment's index.ts: the fnMap passed to
// bindNativeFns maps verb → impl identifier; each impl's body is the span
// from its top-level declaration to the next top-level declaration. A hit
// outside any mapped span (module init, helpers, non-index files) attributes
// to "<segment>:module".
//
// Deliberately NOT extracted (dynamic keys — unknowable statically):
//   • template-literal keys: resolveFn(state, `sound.${verb}`) (doom),
//     `${type}_hydrate` schema-protocol construction, `${channel}.drain`
//   • local resolver wrappers: sheetsync's R(state, "X", …), doom's sfn("x")
//   • SchemaCel protocols (isChanged/hydrate/dehydrate/sourceDehydrate) —
//     type plumbing, not verb-to-verb calls
//
// Output: src/甲骨坑/application/origin/call-graph.json
//   { generated, verbs: { <verb>: { segment, calls: [{to, kind, file, line}],
//                                   calledBy: [<verb>] } } }
// Only verbs with at least one edge in either direction are included.
//
// VALIDATION: every edge target must be a cel key declared in some 甲骨.json
// seed. One seed walk IS the whole universe: the kernel's own cels
// (hydrate/runCycle/setValue/…) live in src/甲骨坑/kernel/甲骨.json, and the
// installer-bound segments (js-common-schema, buffer-schema) declare their
// cels in their seeds too — only the _fn binding is code-side. ChannelCels,
// SchemaCels, ValueCels all count (drain/dispatch targets may be channels).
// A miss means a verb calls a verb that NO LONGER EXISTS → print every
// broken edge and exit(1); `build` runs this before tsc, so it fails the
// build. Runtime-minted targets go on the explicit allowlist below.
// ============================================================================

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(PKG_ROOT, "src", "甲骨坑");
const OUT = path.join(SRC, "application", "origin", "call-graph.json");
const SKIP_DIRS = new Set(["dist", "node_modules", "test", "llm-eval"]);

// ── allowlist: edge targets minted at RUNTIME, never declared in a seed ─────
// Exact keys or explicit prefixes only, one justification per entry. Do NOT
// add entries to make real breakage pass — catching calls into removed verbs
// is the point of the check.
const ALLOW_EXACT = new Set([
  // (none yet — populated only with verified runtime-minted keys)
]);
const ALLOW_PREFIX = [
  // (none yet)
];
const isAllowedTarget = (key) =>
  ALLOW_EXACT.has(key) || ALLOW_PREFIX.some((p) => key.startsWith(p));

const rel = (p) => path.relative(PKG_ROOT, p).split(path.sep).join("/");

// ── walk ─────────────────────────────────────────────────────────────────────
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const files = walk(SRC);
const seedFiles = files.filter((p) => path.basename(p) === "甲骨.json");
const tsFiles = files.filter((p) => p.endsWith(".ts"));

// ── segment naming + cel→segment index (for calledBy segment lookup) ────────
// A file's segment is the 甲骨.json "name" of the nearest segment dir
// (…/甲骨坑/library/<seg>/**, …/application/<seg>/**, …/甲骨坑/kernel/**).
const segNameByDir = new Map(); // abs segment dir → name
for (const s of seedFiles) {
  const dir = path.dirname(s);
  let name = path.basename(dir);
  try {
    const parsed = JSON.parse(readFileSync(s, "utf8"));
    if (typeof parsed.name === "string" && parsed.name) name = parsed.name;
  } catch { /* fall back to dir name */ }
  segNameByDir.set(dir, name);
}
const segmentOfFile = (p) => {
  for (let d = path.dirname(p); d.length >= SRC.length; d = path.dirname(d)) {
    if (segNameByDir.has(d)) return segNameByDir.get(d);
    if (d === SRC) break;
  }
  // segment dirs without a seed (csp, lang-module, segment-io …)
  const parts = rel(p).split("/");
  const i = parts.findIndex((x) => x === "library" || x === "application");
  return i >= 0 ? parts[i + 1] : parts[parts.length - 2] ?? "misc";
};

const celSegment = new Map(); // cel key → segment name
for (const s of seedFiles) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(s, "utf8")); } catch { continue; }
  const seg = segNameByDir.get(path.dirname(s));
  for (const c of parsed.cels ?? []) if (c && c.key) celSegment.set(c.key, seg);
}

// ── edge collection ──────────────────────────────────────────────────────────
const edges = []; // { from, fromSegment, to, kind, file, line }
const addEdge = (from, fromSegment, to, kind, file, line) => {
  if (!from || !to || from === to) return;
  edges.push({ from, fromSegment, to, kind, file, line });
};

const lineOfIndex = (text, idx) => {
  let line = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

// ── TS pass: fnMap spans + resolveFn / dispatch hits ─────────────────────────
// fnMap pairs inside every bindNativeFns(…, new Map([ … ])) region.
const fnMapPairs = (text) => {
  const pairs = []; // { verb, impl }
  for (const m of text.matchAll(/bindNativeFns\(/g)) {
    const mapAt = text.indexOf("new Map", m.index);
    if (mapAt === -1) continue;
    const open = text.indexOf("[", mapAt);
    if (open === -1) continue;
    let depth = 0, k = open;
    while (k < text.length) {
      const ch = text[k];
      if (ch === "[") depth++;
      else if (ch === "]" && --depth === 0) break;
      k++;
    }
    const region = text.slice(open, k + 1);
    for (const e of region.matchAll(/\[\s*"([^"]+)"\s*,\s*([A-Za-z_$][\w$]*)\s*\]/g)) {
      pairs.push({ verb: e[1], impl: e[2] });
    }
  }
  return pairs;
};

// Top-level declarations, ordered: the body of decl i spans [line_i, line_{i+1}).
const topDecls = (text) => {
  const decls = [];
  const re = /^(?:export\s+)?(?:const|let|var|async\s+function|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of text.matchAll(re)) {
    if (m.index > 0 && text[m.index - 1] !== "\n") continue; // column 0 only
    decls.push({ name: m[1], line: lineOfIndex(text, m.index) });
  }
  return decls;
};

for (const p of tsFiles) {
  const text = readFileSync(p, "utf8");
  const seg = segmentOfFile(p);
  const file = rel(p);

  // impl ident → verbs (only index.ts carries a fnMap, but run everywhere —
  // non-index files simply yield no pairs and attribute to module).
  const verbsByImpl = new Map();
  for (const { verb, impl } of fnMapPairs(text)) {
    (verbsByImpl.get(impl) ?? verbsByImpl.set(impl, []).get(impl)).push(verb);
  }
  const decls = topDecls(text);
  const callerAt = (line) => {
    let owner;
    for (const d of decls) {
      if (d.line <= line) owner = d; else break;
    }
    const verbs = owner ? verbsByImpl.get(owner.name) : undefined;
    return verbs && verbs.length ? verbs : [`${seg}:module`];
  };

  // resolveFn(state|st|s …, "X") — first arg must be a state-ish identifier.
  for (const m of text.matchAll(/resolveFn\(\s*(?:state|st|s)\b[^,()]*,\s*(["'])([^"'`\n]+)\1/g)) {
    const line = lineOfIndex(text, m.index);
    for (const from of callerAt(line)) addEdge(from, seg, m[2], "resolveFn", file, line);
  }
  // dispatch: "X" in vnode handler specs.
  for (const m of text.matchAll(/dispatch:\s*(["'])([^"'`\n]+)\1/g)) {
    const line = lineOfIndex(text, m.index);
    for (const from of callerAt(line)) addEdge(from, seg, m[2], "dispatch", file, line);
  }
}

// ── seed pass: on-handlers, channel drain/dispose, emitsTo ──────────────────
const ON_SEXPR = /\(on\s+"[^"]+"\s+"([^"]+)"/g;          // (on "click" "verb" …)
const ON_INFIX = /\bon\(\s*(["'])[^"']+\1\s*,\s*(["'])([^"']+)\2/g; // on("click","verb")

for (const s of seedFiles) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(s, "utf8")); } catch { continue; }
  const raw = readFileSync(s, "utf8");
  const seg = segNameByDir.get(path.dirname(s));
  const file = rel(s);
  const lineOfKey = (key) => {
    const idx = raw.indexOf(`"key": ${JSON.stringify(key)}`);
    return idx === -1 ? 1 : lineOfIndex(raw, idx);
  };

  for (const c of parsed.cels ?? []) {
    if (!c || !c.key) continue;
    const line = lineOfKey(c.key);
    if (typeof c.f === "string") {
      for (const m of c.f.matchAll(ON_SEXPR)) addEdge(c.key, seg, m[1], "dispatch", file, line);
      for (const m of c.f.matchAll(ON_INFIX)) addEdge(c.key, seg, m[3], "dispatch", file, line);
    }
    if (c.celType === "ChannelCel" && c.v && typeof c.v === "object") {
      if (typeof c.v.drain === "string") addEdge(c.key, seg, c.v.drain, "drain", file, line);
      if (typeof c.v.dispose === "string") addEdge(c.key, seg, c.v.dispose, "drain", file, line);
    }
    const emitsTo = c.metadata && c.metadata.emitsTo;
    if (typeof emitsTo === "string" && emitsTo) addEdge(c.key, seg, emitsTo, "emits", file, line);
  }
}

// ── assemble { verbs } with derived calledBy ─────────────────────────────────
const verbs = {};
const entry = (name, segment) => (verbs[name] ??= { segment: segment ?? celSegment.get(name) ?? (name.includes(":") ? name.split(":")[0] : ""), calls: [], calledBy: [] });

const seen = new Set();
for (const e of edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind) || a.line - b.line)) {
  const sig = `${e.from} ${e.to} ${e.kind} ${e.file} ${e.line}`;
  if (seen.has(sig)) continue;
  seen.add(sig);
  entry(e.from, e.fromSegment).calls.push({ to: e.to, kind: e.kind, file: e.file, line: e.line });
  const t = entry(e.to);
  if (!t.calledBy.includes(e.from)) t.calledBy.push(e.from);
}
for (const v of Object.values(verbs)) v.calledBy.sort();

const sorted = Object.fromEntries(Object.keys(verbs).sort().map((k) => [k, verbs[k]]));

let generated = "dev";
try { generated = execSync("git rev-parse --short HEAD", { cwd: PKG_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev"; } catch { /* not a repo / no git */ }

writeFileSync(OUT, JSON.stringify({ generated, verbs: sorted }, null, 2) + "\n");

// ── validation: every edge target must be a seed-declared cel key ───────────
// celSegment's key set IS the known-keys universe (all cels, all celTypes,
// every 甲骨.json under src/甲骨坑 — kernel seeds included).
const broken = [];
for (const [from, v] of Object.entries(sorted)) {
  for (const c of v.calls) {
    if (!celSegment.has(c.to) && !isAllowedTarget(c.to)) broken.push({ from, ...c });
  }
}

// ── stats ────────────────────────────────────────────────────────────────────
const byKind = {};
let edgeCount = 0;
for (const v of Object.values(sorted)) for (const c of v.calls) { byKind[c.kind] = (byKind[c.kind] ?? 0) + 1; edgeCount++; }

if (broken.length) {
  console.error(`call-graph: ${broken.length} edge(s) point at verbs that do not exist:`);
  for (const b of broken) console.error(`  ${b.from} → ${b.to} (${b.kind}, ${b.file}:${b.line})`);
  process.exit(1);
}
console.log(`call-graph: ${Object.keys(sorted).length} verbs, ${edgeCount} edges, all targets resolve → ${rel(OUT)}`);
for (const [k, n] of Object.entries(byKind).sort()) console.log(`  ${k}: ${n}`);
