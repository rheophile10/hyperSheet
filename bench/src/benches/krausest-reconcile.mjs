// krausest reconcile profile on the new plastron-dom: build vs keyed diff.
//   node src/benches/krausest-reconcile.mjs
import { createInitialState, resolveFn } from "../../../plastron/dist/index.js";
import { diffVNodes } from "../../../plastron/dist/甲骨坑/library/plastron-dom/utils/diff.js";
const s = createInitialState(); const R=(k)=>resolveFn(s,k);
await R("ensureSegments")(s,["plastron-dom"]); await R("hydrate")(s,[],[]);
const eq = { vnodeEquals: R("vnode.equals") };
const elt=(tag,attrs,children)=>({type:"el",tag,...(attrs?{attrs}:{}),...(children?{children}:{})});
const tx=(t)=>({type:"text",text:String(t)});
const buildTbody=(rows,sel)=>({type:"el",tag:"tbody",children:rows.map(r=>({type:"el",tag:"tr",key:"row-"+r.id,attrs:r.id===sel?{class:"danger"}:{},children:[
  elt("td",{class:"col-md-1"},[tx(r.id)]), elt("td",{class:"col-md-4"},[elt("a",{class:"lbl"},[tx(r.label)])]),
  elt("td",{class:"col-md-1"},[elt("a",{class:"remove"},[elt("span",{class:"glyphicon glyphicon-remove"},[])])]), elt("td",{class:"col-md-6"},[])]}))});
let id=1; const data=(n)=>Array.from({length:n},()=>({id:id++,label:`item ${id} blue chair`}));
const t=(f)=>{const a=performance.now();f();return performance.now()-a;};
const med=(f,k=30)=>{const xs=[];for(let i=0;i<k;i++)xs.push(f());xs.sort((a,b)=>a-b);return xs[xs.length>>1];};
let rows=data(1000); let tb=buildTbody(rows,null);
console.log("create 1000:   build", med(()=>t(()=>buildTbody(rows,null))).toFixed(2)+"ms   diff", med(()=>t(()=>diffVNodes(null,buildTbody(rows,null),eq))).toFixed(2)+"ms");
console.log("update 10th:   build", med(()=>{const r2=rows.map((r,i)=>i%10===0?{...r,label:r.label+" !!!"}:r);return t(()=>buildTbody(r2,null));}).toFixed(2)+"ms   diff", med(()=>{const r2=rows.map((r,i)=>i%10===0?{...r,label:r.label+" !!!"}:r);const nx=buildTbody(r2,null);return t(()=>diffVNodes(tb,nx,eq));}).toFixed(2)+"ms");
console.log("swap rows:     build", med(()=>{const r2=rows.slice();const x=r2[1];r2[1]=r2[998];r2[998]=x;return t(()=>buildTbody(r2,null));}).toFixed(2)+"ms   diff", med(()=>{const r2=rows.slice();const x=r2[1];r2[1]=r2[998];r2[998]=x;const nx=buildTbody(r2,null);return t(()=>diffVNodes(tb,nx,eq));}).toFixed(2)+"ms");
console.log("remove 1:      build", med(()=>{const r2=rows.filter((_,i)=>i!==500);return t(()=>buildTbody(r2,null));}).toFixed(2)+"ms   diff", med(()=>{const r2=rows.filter((_,i)=>i!==500);const nx=buildTbody(r2,null);return t(()=>diffVNodes(tb,nx,eq));}).toFixed(2)+"ms");
