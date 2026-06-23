import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";

// Wiki provenance: a cel stamped with metadata.definedBy (the := / binder cell)
// renders a "defined by →" link in its article — surfacing symbol provenance
// the docgraph previously ignored.

const find = (node, pred, acc = []) => {
  if (!node || typeof node !== "object") return acc;
  if (pred(node)) acc.push(node);
  for (const k of ["kids", "children"]) if (Array.isArray(node[k])) for (const c of node[k]) find(c, pred, acc);
  return acc;
};
const textOf = (n) => find(n, (x) => x.type === "text").map((x) => x.text).join("");
const linksOf = (n) =>
  find(n, (x) => x.tag === "button" && x.events?.click?.dispatch === "wiki.open").map((x) => x.events.click.payload);

test("a minted verb's article links back to the := cell that defined it", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["docgraph"]);
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);

  const setCel = resolveFn(state, "setCel");
  // the binder cell …
  await setCel(state, "sheet.C1", { celType: "ValueCel", v: "math.SUMPLUSONE := LAMBDA(x, SUM(x)+1)", metadata: { segment: "sheet", name: "C1" } });
  // … and the verb it would mint, carrying provenance.
  await setCel(state, "math.SUMPLUSONE", {
    celType: "ValueCel", v: 0,
    metadata: { segment: "math", name: "SUMPLUSONE", definedBy: "sheet.C1", origin: "sheet.C1" },
  });

  await resolveFn(state, "wiki.open")(state, "math.SUMPLUSONE");
  const article = state.cels.get("wiki.article")?.v;

  assert.match(textOf(article), /defined by/, "the provenance section renders");
  assert.ok(linksOf(article).includes("sheet.C1"), "and links to the := cell");
});
