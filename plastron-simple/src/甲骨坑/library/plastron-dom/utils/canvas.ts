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
}

const n = (v: unknown, d = 0): number => { const x = Number(v); return Number.isFinite(x) ? x : d; };

const replay = (ctx: Ctx2D, ops: Op[], w: number, h: number): void => {
  ctx.clearRect(0, 0, w, h);
  for (const o of ops) {
    if (!o || typeof o !== "object") continue;
    switch (o.op) {
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

/** Replay draw-spec ops onto every <canvas data-ops> under `root`. Called by
 *  the painter after applyPatch; guarded so it can never break a flush. */
export const drawCanvases = (root: unknown): void => {
  try {
    const found: CanvasLike[] = [];
    collect(root as CanvasLike, found);
    for (const cv of found) {
      if (typeof cv.getContext !== "function" || typeof cv.getAttribute !== "function") continue;
      const raw = cv.getAttribute("data-ops");
      if (!raw) continue;
      let ops: Op[];
      try { ops = JSON.parse(raw) as Op[]; } catch { continue; }
      if (!Array.isArray(ops)) continue;
      const ctx = cv.getContext("2d") as Ctx2D | null;
      if (!ctx) continue;
      replay(ctx, ops, n(cv.width, 0), n(cv.height, 0));
    }
  } catch { /* a draw failure must never break the paint */ }
};
