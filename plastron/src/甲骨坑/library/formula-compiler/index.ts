import type { 甲骨, Cel, Compiler, Fn, State } from "../../../types/index.js";
import { bindNativeFns, compileFormula, extractDeps } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// formula-compiler — kind "formula": a defn whose body is a PARAMETERIZED
// plastron formula, not JavaScript. Lets you define reusable verbs from the
// formula surface — `layout`, `note`, glue macros — that are themselves just
// (dom …) / arithmetic formulas. The definition lives on the cel's `f`, so it
// is editable and surfaces in the wiki, exactly like a FormulaCel.
//
//   A1:  (mode, kids) => (layoutbox mode kids)     ; an S-expr body with params
//   =FORMULA(A1, "mylayout")                         ; the generic binder
//   =mylayout("grid", …)                             ; calls it like any verb
//
// HOW: parse the `(params) => body` header (the same header form defn already
// uses for js), compile the body once via the kernel's own compileFormula,
// and return a positional Fn. On each call we bind the params to the call args
// and resolve the body's NON-param symbols (verbs like `dom`, cel refs) from the
// registry live, then run the body's evaluator. No re-implementation — it reuses
// the real parser/evaluator.
//
// REACTIVITY: a formula verb is a function of its PARAMETERS. Symbols in the
// body that name other cels are read live at call time, but they are NOT wired
// into the CALLER's inputMap — calling `f(…)` inside a formula does not make the
// caller react to cels the body happens to touch. For reactive data, pass it in
// as a parameter (the caller's own formula reference carries the edge). This is
// the inputMap doctrine: dependencies are intrinsic to the referencing formula.
//
// COST: each call resolves its non-param deps from the registry and walks the
// body AST interpretively (no per-call codegen) — cheap for UI / glue / compose
// verbs, but NOT for hot inner loops. Keep per-sample / per-cell numeric kernels
// native (the cel-granularity lesson). See bench/formula-compiler.bench.
// ============================================================================

// `(p1, p2, …) => body` → split params from body; a bare body has zero params.
const splitHeader = (src: string): { params: string[]; body: string } => {
  const s = src.trim();
  const m = /^\(([^)]*)\)\s*=>\s*([\s\S]+)$/.exec(s);
  if (!m) return { params: [], body: s };
  const params = m[1]!.split(",").map((p) => p.trim()).filter(Boolean);
  return { params, body: m[2]!.trim() };
};

const formulaCompiler: Compiler = ((source: string, state?: State): Fn => {
  const { params, body } = splitHeader(String(source ?? ""));
  const compiled = compileFormula(body, state);
  const bodyFn = (typeof compiled === "function" ? compiled : compiled.fn) as (i: Record<string, unknown>) => unknown;
  const paramSet = new Set(params);
  const deps = (state ? extractDeps(body, state) : extractDeps(body)).filter((d) => !paramSet.has(d));
  const fn: Fn = (...args: unknown[]): unknown => {
    const inputs: Record<string, unknown> = {};
    if (state) {
      for (const d of deps) {
        const c = state.cels.get(d);
        if (c) inputs[d] = (c as { _fn?: unknown })._fn ?? c.v;
      }
    }
    for (let i = 0; i < params.length; i++) inputs[params[i]!] = args[i];
    return bodyFn(inputs);
  };
  return fn;
}) as Compiler;

export const name = "formula-compiler" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["formula", formulaCompiler],
]));
