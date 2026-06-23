// materialize-docs — turn the starter/*.f worksheet recipes into origin-USER
// document archives (apps/docs/<name>.json): run each .f headless, drain the
// genesis, dump the worksheet segment(s) it minted, and re-stamp the manifests
// as role:"user-space" pinned to sheetapp. These bake into index.html and install
// to the store at boot; the icons open them via doc:<name> → origin.opendoc.
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const { createInitialState, resolveFn } = await import("../../plastron/dist/index.js");
const { dumpSegments } = await import("../../plastron/dist/甲骨坑/library/segment-io/index.js");

const here = import.meta.dir;
const starterDir = join(here, "starter");
const outDir = join(here, "apps", "docs");
await mkdir(outDir, { recursive: true });

// each starter file → { docName, loadName } : loadName is the segment origin.load
// hydrates (its closure pulls the rest). turtles' grid that the others ref is its
// data sheet, so it's the load root.
const DOCS = {
  readme:   { load: "readme" },
  keyboard: { load: "keyboard" },
  turtles:  { load: "turtle_data" },
};

const run = async (src) => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["origin"]);
  await resolveFn(s, "hydrate")(s, [], []);
  await resolveFn(s, "runCycle")(s);
  // materialize the worksheet(s) the recipe mints
  await resolveFn(s, "origin.run")(s, "launch.doc", src);
  const drain = resolveFn(s, "drain"), runCycle = resolveFn(s, "runCycle");
  for (let i = 0; i < 8; i++) { await runCycle(s); if (s.cels.get("genesis.commit")) await drain(s, "genesis.commit"); }
  return s;
};

for (const f of (await readdir(starterDir)).sort()) {
  const name = f.replace(/\.f$/, "");
  if (!f.endsWith(".f") || !DOCS[name]) continue;
  const src = await readFile(join(starterDir, f), "utf8");
  const s = await run(src);

  // the recipe generates its grid cels into the `origin` segment (generatedBy the
  // launch cell). Re-stamp each worksheet cel (<layer>.A1) into its OWN segment so
  // the doc is a clean origin-user segment, then dump those segments.
  const segSet = new Set();
  for (const [k, c] of s.cels) {
    const m = k.match(/^(.+)\.[A-Z]+\d+$/);
    if (m && c.metadata?.generatedBy) { c.metadata.segment = m[1]; segSet.add(m[1]); }
  }
  const segs = [...segSet];
  const arch = JSON.parse(dumpSegments(s, segs));
  for (const seg of arch.segments) for (const c of seg.cels) { if (c.metadata) delete c.metadata.generatedBy; }

  // re-stamp every minted segment as an origin-user doc of sheetapp
  // deps = sheetapp only (NOT a circular all-depend-on-all — that's a hydrate
  // cycle). A doc segment that cross-references another (turtle_charts → turtle_data)
  // depends on it one-way; detect that from the cel sources.
  const srcOf = (seg) => arch.segments.find((g) => g.name === seg).cels.map((c) => String(c.f ?? "")).join(" ");
  arch.manifests = segs.map((seg) => ({
    name: seg, version: "0.0.1", description: `${name} (a sheetapp document)`,
    role: "user-space", kind: "origin-user", applications: ["sheetapp"],
    dependencies: ["sheetapp", ...segs.filter((o) => o !== seg && srcOf(seg).includes(o))],
  }));
  arch.docLoad = DOCS[name].load;

  await writeFile(join(outDir, `${name}.json`), JSON.stringify(arch, null, 2));
  console.log(`✔ apps/docs/${name}.json — segments [${segs.join(", ")}], load root "${DOCS[name].load}"`);
}
