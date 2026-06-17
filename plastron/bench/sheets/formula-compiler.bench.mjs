import { createInitialState, resolveFn } from "/home/ian/projects/plastron/plastron/dist/index.js";

const boot = async () => {
  const state = createInitialState();
  const R = (k)=>resolveFn(state,k);
  await R("ensureSegments")(state, ["builtins","defn","formula-compiler","quickjs-compiler","js-compiler","html-template-parser","dom"]);
  await R("hydrate")(state, [], []);
  await R("runCycle")(state);
  return state;
};
const define = async (state, kind, name, src) => {
  const R=(k)=>resolveFn(state,k);
  await R("setCel")(state, name+"_src", { celType:"ValueCel", v: src, metadata:{segment:"user"} });
  await R("setCel")(state, name+"_bind", { celType:"FormulaCel", f:`(${kind} ${name}_src "${name}")`, metadata:{segment:"user"} });
  await R("runCycle")(state);
  await R("drain")(state, "defn.commit");
  const made = state.cels.get(name);
  if (!made) throw new Error(`define ${name} (${kind}) failed: ${JSON.stringify(state.cels.get(name+"_bind")?.v)}`);
  return resolveFn(state, name);
};
const bench = (label, fn, args, iters) => {
  for (let i=0;i<5000;i++) fn(...args);              // warm up
  const t0 = process.hrtime.bigint();
  let acc;
  for (let i=0;i<iters;i++) acc = fn(...args);
  const ns = Number(process.hrtime.bigint()-t0);
  return { label, opsPerSec: Math.round(iters/(ns/1e9)), nsPerCall: +(ns/iters).toFixed(1), sample: acc };
};

const state = await boot();

// ── arithmetic: pure call overhead ──────────────────────────────────────────
const R=(k)=>resolveFn(state,k);
await R("setCel")(state,"n_mul",{celType:"LockedLambdaCel", fn:((a,b)=>a*b+1), metadata:{segment:"user",kind:"native"}});
const nativeMul = resolveFn(state,"n_mul");
const fMul = await define(state, "formula", "f_mul", "(a, b) => (+ (* a b) 1)");
const qMul = await define(state, "quickjs", "q_mul", "(a, b) => a*b+1");

console.log("=== arithmetic  f(a,b)=a*b+1   (sanity:", nativeMul(6,7), fMul(6,7), qMul(6,7), ") ===");
const ITER = 2_000_000;
const results = [
  bench("native   (TS verb)", nativeMul, [6,7], ITER),
  bench("formula  (=FORMULA)", fMul,      [6,7], ITER),
  bench("quickjs  (=QUICKJS)", qMul,      [6,7], ITER),
];
const base = results[0].opsPerSec;
for (const r of results) console.log(`  ${r.label}: ${r.nsPerCall} ns/call   ${(r.opsPerSec/1e6).toFixed(2)} M ops/s   ${(base/r.opsPerSec).toFixed(1)}x slower`);

// ── compose: a dom-building verb (the realistic use case) ───────────────────
await R("setCel")(state,"n_box",{celType:"LockedLambdaCel", fn:((m,x)=>resolveFn(state,"dom")(`div.b-${m}`, x)), metadata:{segment:"user",kind:"native"}});
const nBox = resolveFn(state,"n_box");
const fBox = await define(state, "formula", "f_box", '(m, x) => (dom "div.box" m x)');
console.log("\n=== compose  f(m,x)=>dom(...)   (sanity:", JSON.stringify(fBox("grid","hi")).slice(0,70), ") ===");
const ITER2 = 1_000_000;
const r2 = [ bench("native   (TS verb)", nBox, ["grid","hi"], ITER2), bench("formula  (=FORMULA)", fBox, ["grid","hi"], ITER2) ];
const base2 = r2[0].opsPerSec;
for (const r of r2) console.log(`  ${r.label}: ${r.nsPerCall} ns/call   ${(r.opsPerSec/1e6).toFixed(2)} M ops/s   ${(base2/r.opsPerSec).toFixed(1)}x slower`);
