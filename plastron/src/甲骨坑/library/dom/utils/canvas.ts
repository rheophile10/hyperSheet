// ============================================================================
// Draw-spec replay — the canvas half of "specs as values". A <canvas> painted
// by the normal vnode pipeline carries its op list as a `data-ops` JSON attr
// (produced by the plastron-canvas vocabulary); after each paint we read that
// attr and replay the ops onto the element's 2d context. Feature-detected and
// fully wrapped: a fake-DOM canvas (tests) or off-browser node is a no-op, and
// nothing here may ever throw into the painter's flush.
// ============================================================================

interface CanvasLike {
  nodeType?: number;
  tagName?: string;
  width?: number;
  height?: number;
  isConnected?: boolean;
  childNodes?: ArrayLike<unknown>;
  getAttribute?(name: string): string | null;
  getContext?(kind: string): unknown;
}

type Op = Record<string, unknown>;

// Just the 2d-context surface we drive (the kernel lib omits DOM types).
interface Ctx2D {
  fillStyle: string; strokeStyle: string; lineWidth: number; font: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(t: string, x: number, y: number): void;
  beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void; stroke(): void; fill(): void;
  closePath(): void; save(): void; restore(): void; setLineDash(d: number[]): void;
}

const n = (v: unknown, d = 0): number => { const x = Number(v); return Number.isFinite(x) ? x : d; };

// an op that depends on `t` → the canvas must redraw each frame (rAF loop)
const isAnimated = (o: Op): boolean => o?.op === "orbit" || o?.op === "frames" || o?.op === "draggable";

// drag state for a draggable canvas: the live rect box + whether it's grabbed.
type Drag = { x: number; y: number; w: number; h: number; dragging: boolean; ox: number; oy: number };
type DragCanvas = CanvasLike & {
  addEventListener?(t: string, h: (e: { clientX: number; clientY: number }) => void): void;
  getBoundingClientRect?(): { left: number; top: number };
};
// attach mouse handlers ONCE per draggable canvas. mousemove/mouseup live on
// window (a drag travels outside the canvas); both no-op once the canvas leaves
// the DOM. mouseup snaps the rect to the nearest `zone` center.
const attachDrag = (cv: CanvasLike, st: { ops: Op[]; drag: Drag }): void => {
  const dc = cv as DragCanvas;
  const win = globalThis as { addEventListener?: (t: string, h: (e: { clientX: number; clientY: number }) => void) => void };
  const at = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = dc.getBoundingClientRect ? dc.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  let grabbed = false;
  dc.addEventListener?.("mousedown", (e) => {
    const d = st.drag, p = at(e);
    if (p.x >= d.x && p.x <= d.x + d.w && p.y >= d.y && p.y <= d.y + d.h) { d.dragging = true; d.ox = p.x - d.x; d.oy = p.y - d.y; grabbed = true; }
  });
  // a grab → swallow the click it produces, so it doesn't reach the cell's
  // edit handler (which would swap the canvas out). Clicking elsewhere on the
  // canvas still propagates (so the cell stays editable).
  dc.addEventListener?.("click", (e) => { if (grabbed) { (e as { stopPropagation?: () => void }).stopPropagation?.(); grabbed = false; } });
  win.addEventListener?.("mousemove", (e) => {
    const d = st.drag; if (!d.dragging || cv.isConnected === false) return;
    const p = at(e); d.x = p.x - d.ox; d.y = p.y - d.oy;
  });
  win.addEventListener?.("mouseup", () => {
    const d = st.drag; if (!d.dragging) return; d.dragging = false;
    const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
    let best: Op | null = null, bd = Infinity;
    for (const z of st.ops) {
      if (z?.op !== "zone") continue;
      const zx = n(z.x) + n(z.w) / 2, zy = n(z.y) + n(z.h) / 2, dd = (zx - cx) ** 2 + (zy - cy) ** 2;
      if (dd < bd) { bd = dd; best = z; }
    }
    if (best) { d.x = n(best.x) + n(best.w) / 2 - d.w / 2; d.y = n(best.y) + n(best.h) / 2 - d.h / 2; }
  });
};

const replay = (ctx: Ctx2D, ops: Op[], w: number, h: number, t = 0): void => {
  ctx.clearRect(0, 0, w, h);
  for (const o of ops) {
    if (!o || typeof o !== "object") continue;
    switch (o.op) {
      case "orbit": {
        // a planet circling (cx,cy) at radius orbitR, once per `period` sec
        const cx = n(o.cx), cy = n(o.cy), orbitR = n(o.orbitR), planetR = n(o.planetR);
        const period = Math.max(0.1, n(o.period, 8));
        ctx.beginPath(); ctx.arc(cx, cy, orbitR, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = 1; ctx.stroke();
        const ang = (t / 1000 / period) * Math.PI * 2 + n(o.phase);
        const px = cx + orbitR * Math.cos(ang), py = cy + orbitR * Math.sin(ang);
        ctx.beginPath(); ctx.arc(px, py, planetR, 0, Math.PI * 2);
        ctx.fillStyle = String(o.color ?? "#fff"); ctx.fill();
        break;
      }
      case "rect":
        if (o.fill) { ctx.fillStyle = String(o.fill); ctx.fillRect(n(o.x), n(o.y), n(o.w), n(o.h)); }
        if (o.stroke) { ctx.strokeStyle = String(o.stroke); ctx.lineWidth = n(o.lineWidth, 1); ctx.strokeRect(n(o.x), n(o.y), n(o.w), n(o.h)); }
        break;
      case "text":
        ctx.fillStyle = String(o.fill ?? "#000");
        ctx.font = String(o.font ?? "14px system-ui");
        ctx.fillText(String(o.text ?? ""), n(o.x), n(o.y));
        break;
      case "line": {
        const pts = (o.points as number[][]) ?? [];
        if (pts.length < 2) break;
        ctx.beginPath();
        ctx.moveTo(n(pts[0]![0]), n(pts[0]![1]));
        for (let i = 1; i < pts.length; i++) ctx.lineTo(n(pts[i]![0]), n(pts[i]![1]));
        ctx.strokeStyle = String(o.stroke ?? "#000");
        ctx.lineWidth = n(o.lineWidth, 1);
        ctx.stroke();
        break;
      }
      case "circle":
        ctx.beginPath();
        ctx.arc(n(o.x), n(o.y), n(o.r), 0, Math.PI * 2);
        if (o.fill) { ctx.fillStyle = String(o.fill); ctx.fill(); }
        if (o.stroke) { ctx.strokeStyle = String(o.stroke); ctx.lineWidth = n(o.lineWidth, 1); ctx.stroke(); }
        break;
      case "wedge": {
        // a pie slice: center → arc a0..a1 → back to center
        const cx = n(o.cx), cy = n(o.cy);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, n(o.r), n(o.a0), n(o.a1));
        ctx.closePath();
        if (o.fill) { ctx.fillStyle = String(o.fill); ctx.fill(); }
        if (o.stroke) { ctx.strokeStyle = String(o.stroke); ctx.lineWidth = n(o.lineWidth, 1); ctx.stroke(); }
        break;
      }
      case "frames": {
        // play a precomputed trajectory (a def-driven sim) — a circle at the
        // frame the time `t` lands on. The physics that made the frames lives
        // in the def'd JS fn; this op only schedules + draws.
        const fr = (o.frames as number[][]) ?? [];
        if (!fr.length) break;
        const period = Math.max(0.1, n(o.period, 4));
        const idx = ((Math.floor((t / 1000 / period) * fr.length) % fr.length) + fr.length) % fr.length;
        const p = fr[idx]!;
        if (o.box) { ctx.strokeStyle = String(o.box); ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, w - 1, h - 1); }
        ctx.beginPath(); ctx.arc(n(p[0]), n(p[1]), n(o.r, 10), 0, Math.PI * 2);
        ctx.fillStyle = String(o.fill ?? "#e91e63"); ctx.fill();
        break;
      }
      case "zone": {
        // a drop target — dashed box + optional label
        ctx.save(); ctx.setLineDash([6, 4]);
        ctx.strokeStyle = String(o.stroke ?? "rgba(150,150,175,.7)"); ctx.lineWidth = 2;
        ctx.strokeRect(n(o.x), n(o.y), n(o.w), n(o.h)); ctx.restore();
        if (o.label) { ctx.fillStyle = String(o.stroke ?? "rgba(150,150,175,.8)"); ctx.font = "13px system-ui"; ctx.fillText(String(o.label), n(o.x) + 7, n(o.y) + 19); }
        break;
      }
      case "draggable": {
        // a movable rect (position updated by the drag handlers each frame)
        ctx.fillStyle = String(o.fill ?? "#e91e63");
        ctx.fillRect(n(o.x), n(o.y), n(o.w), n(o.h));
        ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 2;
        ctx.strokeRect(n(o.x), n(o.y), n(o.w), n(o.h));
        break;
      }
    }
  }
};

const collect = (node: CanvasLike, out: CanvasLike[]): void => {
  if (!node) return;
  if (node.nodeType !== undefined && node.nodeType !== 1) return; // skip text/comment nodes
  if (node.tagName === "CANVAS") out.push(node);
  const kids = node.childNodes;
  if (kids) for (let i = 0; i < kids.length; i++) collect(kids[i] as CanvasLike, out);
};

// per-canvas animation state — one rAF loop per animated canvas; the loop
// reads the latest ops from here (so a re-paint just updates `ops`), and
// self-cancels when the element leaves the DOM.
const anim = new WeakMap<object, { ops: Op[]; drag?: Drag }>();
const raf: ((cb: () => void) => number) | null =
  typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame === "function"
    ? (globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame
    : null;
const clock = (): number => {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof p?.now === "function" ? p.now() : 0;
};

/** Replay draw-spec ops onto every <canvas data-ops> under `root`. Called by
 *  the painter after applyPatch; guarded so it can never break a flush. An
 *  animated canvas (orbit ops) gets a self-cancelling rAF loop. */
export const drawCanvases = (root: unknown): void => {
  try {
    const found: CanvasLike[] = [];
    collect(root as CanvasLike, found);
    for (const cv of found) {
      if (typeof cv.getContext !== "function" || typeof cv.getAttribute !== "function") continue;
      const rawAttr = cv.getAttribute("data-ops");
      if (!rawAttr) continue;
      let ops: Op[];
      try { ops = JSON.parse(rawAttr) as Op[]; } catch { continue; }
      if (!Array.isArray(ops)) continue;
      const ctx = cv.getContext("2d") as Ctx2D | null;
      if (!ctx) continue;

      if (ops.some(isAnimated) && raf) {
        const dragOp = ops.find((o) => o?.op === "draggable");
        const newDrag = (): Drag => ({ x: n(dragOp!.x), y: n(dragOp!.y), w: n(dragOp!.w), h: n(dragOp!.h), dragging: false, ox: 0, oy: 0 });
        const existing = anim.get(cv as object);
        if (existing) {
          existing.ops = ops; // loop already running — swap ops
          // element reused (e.g. an animated canvas became a draggable one):
          // wire up drag now, since the loop won't be re-created.
          if (dragOp && !existing.drag) { existing.drag = newDrag(); attachDrag(cv, existing as { ops: Op[]; drag: Drag }); }
          continue;
        }
        const state: { ops: Op[]; drag?: Drag } = { ops };
        if (dragOp) { state.drag = newDrag(); attachDrag(cv, state as { ops: Op[]; drag: Drag }); }
        anim.set(cv as object, state);
        const frame = (): void => {
          if (cv.isConnected === false) { anim.delete(cv as object); return; } // gone from DOM → stop
          if (state.drag) for (const o of state.ops) if (o?.op === "draggable") { o.x = state.drag.x; o.y = state.drag.y; }
          try { replay(cv.getContext!("2d") as Ctx2D, state.ops, n(cv.width, 0), n(cv.height, 0), clock()); } catch { /* keep looping */ }
          raf(frame);
        };
        frame();
      } else {
        replay(ctx, ops, n(cv.width, 0), n(cv.height, 0));
      }
    }
  } catch { /* a draw failure must never break the paint */ }
};
