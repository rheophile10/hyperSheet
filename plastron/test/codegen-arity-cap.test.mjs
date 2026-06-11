import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// wide-flat OOM fix: a formula with more distinct scalar refs than
// MAX_CODEGEN_SYMBOLS must fall back to the AST-walk interpreter instead of
// inlining a giant `new Function` body that OOMs the parser.
test("a high-arity (+ …) formula evaluates via AST-walk — no codegen OOM", async () => {
  const s = createInitialState();
  const N = 5000; // > the 2000 codegen cap
  const cels = [];
  for (let i = 0; i < N; i++) cels.push({ key: `c${i}`, celType: "ValueCel", metadata: { key: `c${i}`, segment: "u" }, v: 1 });
  cels.push({ key: "sum", celType: "FormulaCel", metadata: { key: "sum", segment: "u", parser: "f" }, f: `(+ ${Array.from({ length: N }, (_, i) => `c${i}`).join(" ")})` });
  await resolveFn(s, "hydrate")(s, [{ name: "u", cels }], [{ name: "u", version: "0", description: "", dependencies: [] }]);
  await resolveFn(s, "runCycle")(s);
  assert.equal(resolveFn(s, "getCel")(s, "sum").v, N);
});
