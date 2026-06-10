// ============================================================================
// scale/shapes.mjs — the three graph shapes, each as a builder returning
// { cels, inputKeys, sinkKey, editTargets }.
//
//   cels         — the raw cel specs to hydrate.
//   inputKeys    — value cels an edit can target (the leaves a user pokes).
//   sinkKey      — a representative downstream cel to read for settle proof.
//   editTargets  — value cels chosen for the edit-storm (the interactive
//                  budget cares about poking real leaves, not formulas).
// ============================================================================

import { valueCel, formulaCel } from "./lib.mjs";

// ── wide-flat — N value cels, one SUM over all (input fan-in) ────────────────
// Stresses: a single formula with N-wide fan-in. Every leaf edit re-fires
// the one aggregate. Tests gather cost / wide inputMap.
export const wideFlat = (N) => {
  const seg = "wf";
  const cels = [];
  const inputKeys = [];
  for (let i = 0; i < N; i++) {
    const k = `v${i}`;
    cels.push(valueCel(k, seg, i));
    inputKeys.push(k);
  }
  const refs = inputKeys.join(" ");
  cels.push(formulaCel("sum", seg, `(+ ${refs})`));
  return { seg, cels, inputKeys, sinkKey: "sum", editTargets: inputKeys };
};

// ── deep-chain — N cels each depending on the previous (topo depth) ──────────
// Stresses: cascade propagation depth. An edit at the head walks the whole
// chain; an edit deep in the chain walks the tail. Tests topo depth +
// per-hop cascade overhead.
export const deepChain = (N) => {
  const seg = "dc";
  const cels = [valueCel("c0", seg, 1)];
  for (let i = 1; i < N; i++) {
    // c_i = c_{i-1} + 1  (kept linear so values stay finite at depth)
    cels.push(formulaCel(`c${i}`, seg, `(+ c${i - 1} 1)`));
  }
  // The only true value-cel leaf is the head; edit-storm pokes it (every
  // edit forces a full-depth cascade — the worst case this shape exists
  // to measure).
  return {
    seg,
    cels,
    inputKeys: ["c0"],
    sinkKey: `c${N - 1}`,
    editTargets: ["c0"],
  };
};

// ── diamond-mesh — N×N grid, each cel depends on two neighbors ───────────────
// Stresses: a realistic spreadsheet recompute wavefront. Row 0 and col 0 are
// value cels; every interior cell g(r,c) = g(r-1,c) + g(r,c-1) (the classic
// diamond/Pascal dependency). An edit at (0,0) floods the whole sheet; an
// edit at an interior border floods a sub-triangle. N here is the grid SIDE,
// so the cel count is N*N (caller passes side = round(sqrt(target))).
export const diamondMesh = (side) => {
  const seg = "dm";
  const cels = [];
  const inputKeys = [];
  const key = (r, c) => `g_${r}_${c}`;
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      const k = key(r, c);
      if (r === 0 && c === 0) {
        cels.push(valueCel(k, seg, 1));
        inputKeys.push(k);
      } else if (r === 0) {
        // top edge depends on its left neighbor only
        cels.push(formulaCel(k, seg, `(+ ${key(0, c - 1)} 1)`));
      } else if (c === 0) {
        // left edge depends on its upper neighbor only
        cels.push(formulaCel(k, seg, `(+ ${key(r - 1, 0)} 1)`));
      } else {
        // interior: two-neighbor diamond dependency
        cels.push(formulaCel(k, seg, `(+ ${key(r - 1, c)} ${key(r, c - 1)})`));
      }
    }
  }
  return {
    seg,
    cels,
    inputKeys,
    sinkKey: key(side - 1, side - 1),
    editTargets: inputKeys, // (0,0) — the one true value leaf; flooding edit
    side,
  };
};

// Map a target cel-count N to a builder + the actual cel count it produces.
export const SHAPES = {
  "wide-flat": (N) => ({ ...wideFlat(N), count: N + 1 }),
  "deep-chain": (N) => ({ ...deepChain(N), count: N }),
  "diamond-mesh": (N) => {
    const side = Math.max(2, Math.round(Math.sqrt(N)));
    const built = diamondMesh(side);
    return { ...built, count: side * side };
  },
};
