import type { 甲骨, Cel, Compiler, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// js-compiler — kind "js" is now an ALIAS for QuickJS (wasm sandbox). The
// `new Function` path is REMOVED (wasm-only-functions, 2026-06-10): user
// functions compile inside a QuickJS-wasm VM with no ambient globals — a def'd
// function cannot `fetch`, touch the DOM, or hook anything at the effect site.
// Network/effects exist ONLY through trusted native verbs.
//
// Kept as a thin segment so the "js" kind and its four status cels keep
// working (kind-status); the compiler body DELEGATES to the `quickjs` compiler
// through the cel registry (cels are the only interface — no cross-segment TS
// import). CSP: quickjs needs `wasm`, not `unsafe-eval`, so a strict-CSP page
// that blocks eval now runs "js" lambdas fine (the old eval-availability gate
// is gone). Async: quickjs lazy-loads its wasm on first use, so "js" compiles
// are now async too (the def/defn flow already awaits compiler Promises).
const jsCompiler: Compiler = ((source: string, state?: State) => {
  if (!state) throw new Error("js-compiler: state required to delegate to quickjs");
  const quickjs = resolveFn(state, "quickjs") as Compiler | undefined;
  if (!quickjs) throw new Error("js-compiler: the quickjs compiler is not loaded (kind \"js\" aliases quickjs)");
  return quickjs(source, state);
}) as Compiler;

export const name = "js-compiler" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["js", jsCompiler],
]));
