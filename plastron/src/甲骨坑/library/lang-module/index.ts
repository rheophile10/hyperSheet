// lang-module — Model B of the `functions` segment kind (polyglot-language-
// segments.md, accepted): a SOURCE file explodes into one function-cel per public
// definition. The graph then references functions individually; cross-file /
// intra-module calls stay inside the runtime, off the graph (the doctrine).
//
// Each emitted cel is Model A with a different trailing callable: f = the whole
// source + "\n" + the function name. The runtime evaluates the source (defining
// every helper) and the last expression IS that function — verified for kind "js"
// (js), and the same convention for "py".
//
// Pure (source in, genesis-batch out): the names are PARSED, not executed, so the
// generator needs no runtime. A `module(src, kind)` verb wraps this once a host
// loads the segment; until then it's consumed by direct import (like segment-io).

export type Lang = "js" | "py";

const RE: Record<Lang, RegExp[]> = {
  // top-level function declarations + assigned consts/lets (arrow or fn exprs)
  js: [
    /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=/g,
  ],
  // top-level `def name(` (column 0 — indented defs are nested/private)
  py: [/(?:^|\n)def[ \t]+([A-Za-z_]\w*)[ \t]*\(/g],
};

/** Public definition names in `source` for `kind`. `_`-prefixed names are PRIVATE
 *  (the helper convention) and not exported. De-duplicated, source order. */
export const moduleNames = (source: string, kind: Lang = "js"): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of RE[kind]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const n = m[1]!;
      if (n.startsWith("_") || seen.has(n)) continue;
      seen.add(n); out.push(n);
    }
  }
  return out;
};

interface CelSpec { celType: string; f: string; metadata: Record<string, unknown> }
export interface ModuleGenesis { genesis: true; layer: string; cels: Record<string, CelSpec> }

/** Explode a source file into a genesis batch: one `kind` lambda cel per public
 *  definition (`<segment>.<name>`, f = source + "\n" + name), all owned by the
 *  generator so editing the source regenerates and sweeps renamed/removed fns. */
export const moduleGenesis = (segment: string, source: string, kind: Lang = "js"): ModuleGenesis => {
  const owner = `${segment}.__module`;
  const cels: Record<string, CelSpec> = {};
  for (const name of moduleNames(source, kind)) {
    cels[`${segment}.${name}`] = {
      celType: "EditableLambdaCel",
      f: `${source}\n${name}`,
      metadata: { segment, name, kind, generatedBy: owner },
    };
  }
  return { genesis: true, layer: segment, cels };
};
