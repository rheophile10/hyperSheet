import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// ============================================================================
// render-spec isChanged protocol — the two spike-discovered contracts
// (vnode-valuecel-collapse.md):
//   1. CHANGED-predicate semantics: true = commit+repaint, false =
//      suppress AND keep the old reference (the memoSafe mechanism).
//   2. Deep comparison with a node BUDGET: small fragment trees compare
//      fully; over-budget trees bail as "changed" (bounded cost).
// ============================================================================

const el = (tag, children = [], extra = {}) => ({ type: "el", tag, children, ...extra });
const txt = (t) => ({ type: "text", text: t });
const spec = (vnode) => ({ vnode, mount: "#app", listeners: [] });

const chain = (depth) => {
  let node = txt("leaf");
  for (let i = 0; i < depth; i++) node = el("div", [node]);
  return node;
};

test("changed-predicate semantics over RenderSpecs", () => {
  const state = createInitialState();
  const isChanged = resolveFn(state, "render-spec_isChanged");
  // identical structure (fresh objects) → NOT changed
  assert.equal(isChanged(spec(el("div", [txt("a")])), spec(el("div", [txt("a")]))), false);
  // text difference deep in the tree → changed
  assert.equal(isChanged(spec(el("div", [el("p", [txt("a")])])), spec(el("div", [el("p", [txt("b")])]))), true);
  // attr difference → changed
  assert.equal(isChanged(spec(el("div", [], { attrs: { class: "x" } })), spec(el("div", [], { attrs: { class: "y" } }))), true);
  // mount difference → changed
  assert.equal(isChanged(spec(txt("a")), { vnode: txt("a"), mount: "#other", listeners: [] }), true);
  // null/undefined prev → changed
  assert.equal(isChanged(undefined, spec(txt("a"))), true);
});

test("budget: equal-but-huge trees report changed (bounded compare)", () => {
  const state = createInitialState();
  const isChanged = resolveFn(state, "render-spec_isChanged");
  // small equal trees: full deep compare → not changed
  assert.equal(isChanged(spec(chain(10)), spec(chain(10))), false);
  // equal trees past the budget (64 nodes): bail ⇒ "changed" — the
  // monolith pays O(budget), never O(tree), and falls through to the
  // paint diff (its efficient path).
  assert.equal(isChanged(spec(chain(200)), spec(chain(200))), true);
});

test("suppression keeps the OLD reference on a real view cel", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{
    name: "t", cels: [
      { key: "t.x", celType: "ValueCel", metadata: { key: "t.x", segment: "t" }, v: "hello" },
      { key: "t.flip", celType: "ValueCel", metadata: { key: "t.flip", segment: "t" }, v: 0 },
      // view depends on BOTH; flipping t.flip refires it but the
      // rendered tree only uses t.x — recompute yields an equal tree.
      { key: "t.view", celType: "FormulaCel",
        metadata: { key: "t.view", segment: "t", parser: "html-template", schema: "render-spec",
                    inputMap: { x: "t.x", flip: "t.flip", mount: "t.mount" } },
        f: "<div class=\"v\">{{x}}</div>" },
      { key: "t.mount", celType: "ValueCel", metadata: { key: "t.mount", segment: "t" }, v: null },
    ],
  }], [{ name: "t", version: "0.0.1", dependencies: ["html-template-parser"], role: "library" }]);
  const runCycle = resolveFn(state, "runCycle");
  const setValue = resolveFn(state, "setValue");
  await runCycle(state);
  const before = state.cels.get("t.view").v;
  assert.ok(before && typeof before === "object" && "vnode" in before, "view computed a RenderSpec");

  // refire via an input the tree ignores → equal tree → old ref kept
  await setValue(state, "t.flip", 1);
  assert.equal(state.cels.get("t.view").v, before, "suppression preserved the old reference");

  // real change → new reference, new content
  await setValue(state, "t.x", "world");
  const after = state.cels.get("t.view").v;
  assert.notEqual(after, before);
  assert.equal(JSON.stringify(after.vnode).includes("world"), true);
});
