import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const p = await b.newPage();
await p.goto(new URL("../dist/index.html", import.meta.url).href);
await p.waitForFunction(() => !!globalThis.plastron, { timeout: 8000 });
const out = await p.evaluate(async () => {
  const { state, resolveFn, createPainter, setPainter, precomputeOptional } = globalThis.plastron;
  const R = (k) => resolveFn(state, k);
  const q = [];                                   // queued mock-raf (origin-test pattern)
  setPainter(state, createPainter(state, { raf: (cb) => { q.push(cb); return q.length; }, caf: () => {}, isBrowser: true, doc: document, resolveMount: (m) => document.querySelector(m) }));
  const flush = () => { for (const cb of q.splice(0)) cb(); };
  document.body.insertAdjacentHTML("beforeend", '<table id="kt"><tbody id="tbody"></tbody></table>');
  const elx = (tag, attrs, ch, ev) => ({ type: "el", tag, ...(attrs ? { attrs } : {}), ...(ch ? { children: ch } : {}), ...(ev ? { events: ev } : {}) });
  const tx = (t) => ({ type: "text", text: String(t) });
  const buildTbody = (rows, sel) => ({ vnode: elx("tbody", { id: "tbody" }, rows.map((r) => { const tr = elx("tr", r.id === sel ? { class: "danger" } : {}, [
        elx("td", { class: "col-md-1" }, [tx(r.id)]),
        elx("td", { class: "col-md-4" }, [elx("a", { class: "lbl" }, [tx(r.label)], { click: { dispatch: "krausest:select", payload: r.id } })]),
        elx("td", { class: "col-md-1" }, [elx("a", { class: "remove" }, [elx("span", { class: "glyphicon" }, [])], { click: { dispatch: "krausest:removeRow", payload: r.id } })]),
        elx("td", { class: "col-md-6" }, [])]); tr.key = "row-" + r.id; tr.memo = [r, r.id === sel]; return tr; })), mount: "#tbody", listeners: [] });
  await R("setCel")(state, "buildTbody", { celType: "LockedLambdaCel", fn: buildTbody, metadata: { kind: "native", segment: "krausest" } });
  await R("setCel")(state, "krausest:select", { celType: "LockedLambdaCel", fn: (st, id) => resolveFn(st, "setValue")(st, "krausest:selectedIdx", id), metadata: { kind: "native", segment: "krausest" } });
  await R("setCelBatch")(state, { "krausest:rows": { celType: "ValueCel", v: [], metadata: { segment: "krausest" } }, "krausest:selectedIdx": { celType: "ValueCel", v: null, metadata: { segment: "krausest" } } });
  await R("setCel")(state, "krausest:tbody", { celType: "FormulaCel", f: "(buildTbody rows sel)", metadata: { segment: "krausest", parser: "f", schema: "render-spec", channel: ["plastron-dom.paint"], inputMap: { rows: "krausest:rows", sel: "krausest:selectedIdx" } } });
  await R("runCycle")(state); await precomputeOptional(state); flush();
  const A=["pretty","large","big","small","tall","short"],C=["red","yellow","blue","green"],N=["table","chair","house","car"];
  let id=1; const rnd=(a)=>a[(Math.random()*a.length)|0]; const data=(n)=>Array.from({length:n},()=>({id:id++,label:rnd(A)+" "+rnd(C)+" "+rnd(N)}));
  const rows=()=>state.cels.get("krausest:rows").v; const dom=()=>document.querySelectorAll("#tbody tr").length;
  const op=async(nx)=>{const t0=performance.now();await R("setValue")(state,"krausest:rows",nx);await R("drain")(state,"plastron-dom.paint");flush();return performance.now()-t0;};
  const sel=async(i)=>{const t0=performance.now();await R("setValue")(state,"krausest:selectedIdx",i);await R("drain")(state,"plastron-dom.paint");flush();return performance.now()-t0;};
  const m=(arr)=>arr.sort((a,b)=>a-b)[Math.floor(arr.length/2)];
  const res={};
  let xs=[]; for(let i=0;i<5;i++){await op([]);xs.push(await op(data(1000)));} res.create=[m(xs),dom()];
  xs=[]; for(let i=0;i<5;i++) xs.push(await op(rows().map((x,j)=>j%10===0?{...x,label:x.label+" !!!"}:x))); res.update=[m(xs),dom()];
  xs=[]; for(let i=0;i<5;i++) xs.push(await op((()=>{const a=rows().slice();const u=a[1];a[1]=a[998];a[998]=u;return a;})())); res.swap=[m(xs),dom()];
  xs=[]; for(let i=0;i<5;i++) xs.push(await sel(rows()[i*9].id)); res.select=[m(xs),dom()];
  xs=[]; for(let i=0;i<5;i++){await op(data(1000));xs.push(await op(rows().filter((_,j)=>j!==500)));} res.remove=[m(xs),dom()];
  xs=[]; for(let i=0;i<3;i++){await op([]);xs.push(await op(data(10000)));} res.lots=[m(xs),dom()];
  xs=[]; for(let i=0;i<5;i++){await op(data(1000));xs.push(await op([]));} res.clear=[m(xs),dom()];
  return res;
});
console.log("NEW kernel krausest (median ms, rows-after):");
for(const k of ["create","update","swap","select","remove","lots","clear"]) console.log("  "+k.padEnd(8), out[k][0].toFixed(1).padStart(6)+"ms   rows="+out[k][1]);
await b.close();
