---
title: "onecell → plastron: a granularity & scheduling experiment"
status: under-consideration
area: examples
audience: gpu/geometry/canvas working group
source: https://spiritshare.org/moment.html
---

# onecell → plastron — experiment brief

**For:** the group building the GPU / geometry / canvas content.
**Why you:** the deliverable is a real-time 3D simulation rendered to a canvas via instanced
geometry. It exercises exactly the substrate you're building, and it's a clean, self-contained
testbed to find out where the plastron cel model starts helping and where it gets in the way.

## TL;DR

Port `spiritshare.org/moment.html` ("onecell" — a 3D cellular automaton) onto plastron. Build it
at **three granularities** and compare them:

1. **onecell** — the original, as-is (baseline; vendored in `reference/`).
2. **twoCels** — the *minimal* reactive split: exactly two cels, one `inputMap` edge.
3. **manyCels** — the full plastron shape (~25 boundary cels).

The research question is **not** "make it work in plastron." It's: **at what granularity does the
reactive graph start earning its keep, and where does it become ceremony or fight you?** Write up
the answer; it feeds back into the cel-granularity doctrine in `CLAUDE.md`.

Secondary, explicitly wanted: **absorb the scheduling lessons** (the "learn/lock/lose" adaptive
frame governor). See [§6](#6-the-scheduling-prize-learnlocklose). If it proves out, it likely
wants to be extracted into a reusable library segment — origin already hand-rolls `setInterval`
clock loops that would consume it.

---

## 1. What onecell is (read this before the code)

"Chaos Cube Chi Training Arena" / "onecell" is a **3D cellular automaton**: a 64³ grid (~262k
sites) of a Game-of-Life-style rule extended into 3D with per-cell *health*, physical *push-forces*,
and signal-propagation *wires*. Rendered as a three.js `InstancedMesh`. No framework, one author,
globals + `eval`.

**State = structure-of-arrays.** The entire universe is a handful of parallel typed arrays indexed
by one linear coordinate `p = i*fullH*fullW + j*fullW + k`:

```js
cells     = new Uint16Array(total_cells);  // health / alive value
lifetime  = new Uint32Array(total_cells);  // birth timestamp
neighbors = new Uint16Array(total_cells);  // live-neighbour count, maintained incrementally
posns     = new Uint16Array(total_cells);  // last-RENDERED value (manual dirty buffer)
forces    = new Array(total_cells);        // per-cell [x,y,z] push vector
```

The name is literal — **"one cell": the whole world is a single object.** The opposite of
fine-grained reactivity, and (per our own doctrine) *correctly so* for the interior.

**"Reactivity" = a hand-rolled tick loop, no graph.** `animate() → application()` (one tick: scan
grid, collect births/deaths/lifers, mutate arrays in place) `→ updateInstances() → renderer.render()`.

Key mechanisms to recognise in the source:

- **Manual dirty tracking:** `updateInstances` only touches GPU instances where `cells[n] != posns[n]`,
  then sets `instances.instanceMatrix.needsUpdate = true`. A hand-coded reactive invalidation, by
  full-array scan.
- **Incremental dependencies:** births/deaths call `neighborize(i,j,k,±1)` to bump the 7³−1 stencil's
  neighbour counts instead of rescanning; `countNeighbors()` is the full-recompute fallback. The code
  *jokes about the desync risk this creates* (`if( qRandom(bugcount) > 0.5 ) … "mock the system"`).
- **`decideRule` / `setRuleMult`:** the active ruleset is chosen from the live population
  (`total_alive`), and the six thresholds (`min/max_birth/death/lifer`) are re-derived by hand
  whenever `neighbor_range` or the rule changes.
- **`inKeys`:** ~300 lines of "mutate a global, then manually call `refreshConfig`/`decideRule`/
  `countNeighbors`." This is the "hand-rolled reactivity is a bug waiting to happen" smell, at scale.
- **Persistence:** `exportPosn()` serialises the whole state — *including the RNG state*
  (`rNums, rC, cC`) for deterministic replay — into one JSON/`.bin` blob. There is **no recipe/snapshot
  split**: the state *is* the program. `loadScript`/`importPosn` rehydrate via `eval(field + '=' + ...)`.
- **`one(js){ eval(js) }`** exported to `window`; the whole module sprayed onto globals. No sandbox.
- **The adaptive frame governor** (the prize — see §6).
- **No networking** despite "spiritshare": sharing = download/upload a file.

## 2. The vendored source — `reference/`

The actual files pulled from the live site (read them, port from them):

- `reference/moment.html` — the page shell: importmap, `loadScript`/`selectScript` bootstrap, the
  `[h]`/`[y]` controls.
- `reference/moment1.js` — **the whole engine** (~2500 lines). The interesting functions:
  `application()` (the tick), `updateInstances()`/`updatePixel()` (render diff), `neighborize()`/
  `countNeighbors()` (the stencil), `decideRule()`/`setRuleMult()` (population→rules),
  `watchTimer()`/`animate*()` (**the governor**), `exportPosn()`/`importPosn()`/`loadScript()`
  (persistence), `inKeys()` (the imperative control surface).
- `reference/binary.js` — the custom typed-binary codec (`bin_encode`/`bin_decode`) used for `.bin`
  snapshots. Reusable for the typed-array dehydration problem (§5).
- `reference/toast.js` — UI toasts; ignore for the port.
- (`es_shims.js` is just importmap polyfills — refetch if you need it; not vendored.)

## 3. The discipline (the one rule that governs the whole port)

**The interior of the simulation is NOT cels.** The 262k sites and the neighbour stencil stay inside
a single native-fn cel. Modelling them as cels would be millions of `inputMap` edges of pure
overhead, and the kernel would (correctly) refuse to topo-sort that every frame. This is the literal
endpoint of the `CLAUDE.md` lesson: *"collapsing N intermediate cels into one native-fn cel beats
both per-cel plastron AND react-memo."*

**Cels live only at the sparse boundary** — the knobs, the rule selection, the derived thresholds,
the scheduler, the paint trigger. That's where reactivity buys something (independent observation,
auto-wired re-derives, dehydration, testability). Nowhere else.

Litmus for every edge you add: *could an `inputMap` edge express this?* If yes, use it; if you find
yourself hand-calling a re-derive after a mutation, that's the smell.

---

## 4. The twoCels version (build this FIRST)

This is the controlled experiment. **Exactly two cels, one edge.** Everything onecell keeps as
globals — the knobs, the rules, the entire `application()` — *stays as globals*. We are testing the
value of plastron at its very first increment of granularity: separating **"the sim advanced"** from
**"repaint"**.

- **`world`** — owns the typed arrays (as module state, exactly like onecell). Its *cel value* is just
  a generation counter `number`. The host tick advances the sim in place and bumps it.
- **`frame`** — `inputMap: { world }`. Its fire = paint the `InstancedMesh` from the buffers (a drain
  effect, §7). One edge: `world → frame`.

```ts
// the ONLY reactive surface in twoCels:
let gen = 0;
function tick() {
  applicationTick(buffers, GLOBALS);      // onecell's application(), verbatim, mutates in place
  setValue(state, "world", ++gen);        // bump → runCycle fires `frame` → repaint
  setTimeout(tick, interval);
}
```

**What it tests:** does *one* graph edge (sim→paint) earn its keep versus onecell's fused
`application() → updateInstances()`? Specifically:

- Can you now **throttle or observe render independently** of simulation, for free?
- Add a **third observer** of `world` — a `stats` readout cel (`pop`, `fps`) — in one line. onecell
  *cannot* do this without threading another call into `application()`. If cel #3 is one line and just
  works, the model is already earning its keep at the smallest granularity. **That's the headline
  finding to confirm or refute.**
- Does `runCycle` per frame add measurable overhead when only two boundary cels exist? (Should be ~0;
  measure it.)

twoCels is the pivot. If even this one edge is ceremony-without-benefit, that's a real finding and we
should know it. If it cleanly unlocks multi-observer + snapshot, it tells us *two* is already past the
break-even, and manyCels is just more of a good thing.

## 5. The manyCels version (the full shape)

Then build the full boundary (~25 cels) and see where it stops helping. Inventory:

| Group | celType | keys |
|---|---|---|
| Knobs (the `inKeys` targets) | ValueCel | `neighbor_range`, `opacity`, `spacing`, `sizing`, `damage`, `healing_factor`, `adversity`, `colorBal`, `filterBal`, `groundBal`, `chosen_rules`, `fps_target`, `timer_mode` |
| State handles | ValueCel | `sim.buffers` (typed arrays + dims + **RNG state**), `sim.total_alive`, `sim.generation`, `sim.frame_cost` |
| Derived params | FormulaCel | `sim.span`, `sim.rule_mult`, `sim.active_rule`, `sim.min_birth`…`sim.max_lifer`, `sim.interval` |
| The kernel | LockedLambdaCel | `sim.step` |
| The paint effect | ChannelCel + drain | `three.paint` |

**The win to demonstrate:** onecell's manual re-derives become auto-wired formula edges. `setRuleMult`
+ `decideRule` collapse into:

```ts
const sc = resolveFn(state, "setCel") as Fn;
sc(state, "sim.span", { celType: "FormulaCel", f: "(+ (* 2 neighbor_range) 1)",
   metadata: { key: "sim.span", segment: "sim", name: "span" } });
sc(state, "sim.rule_mult", { celType: "FormulaCel", f: "(- (* sim.span sim.span sim.span) 1)",
   metadata: { key: "sim.rule_mult", segment: "sim", name: "rule_mult" } });
sc(state, "sim.active_rule", { celType: "FormulaCel", f: "(pickRule chosen_rules sim.total_alive)",
   metadata: { key: "sim.active_rule", segment: "sim", name: "active_rule" } });
sc(state, "sim.min_birth", { celType: "FormulaCel",
   f: "(floor (* (member sim.active_rule 'min_birth') sim.rule_mult))",
   metadata: { key: "sim.min_birth", segment: "sim", name: "min_birth" } });
// …max_birth / min_death / max_death / min_lifer / max_lifer identically
```

(`+ - * /` are confirmed builtins; `floor`/`member`/`pickRule` are small native or Excel-inline fns —
the *shape* is the point. Dotted keys like `sim.rule_mult` are legal infix refs.)

Then onecell's 300-line `inKeys` collapses to ~12 `setValue` dispatches — every "then re-derive X"
disappears into the graph:

```ts
// onecell 'A' case (neighbor_range++; prepareNeighbors; setRuleMult; decideRule) becomes:
await setValue(state, "neighbor_range", nr + 1);   // span→rule_mult→thresholds recompute on their own
```

The step kernel reads its inputs **imperatively** (`state.cels.get(k).v`) and is **host-invoked, not
cascade-wired** — this is how you avoid a cycle (§8):

```ts
const step: Fn = async (state) => {
  const buf = state.cels.get("sim.buffers")!.v as Buffers;
  const params = readParams(state);            // min/max_*, damage, healing_factor, adversity, neighbor_range
  const alive = applicationTick(buf, params);  // onecell's application(): births/deaths/lifers/pushAway/wires/entropy — ALL inner compute
  const setV = resolveFn(state, "setValue") as Fn;
  await setV(state, "sim.total_alive", alive);            // feeds sim.active_rule NEXT frame
  await setV(state, "sim.generation", (buf.gen ?? 0) + 1); // bumps the painter
  return state;
};
sc(state, "sim.step", { celType: "LockedLambdaCel", fn: step,
   metadata: { key: "sim.step", segment: "sim", name: "step" } });
```

**Persistence (the split onecell lacks):**
- *Recipe* (`.f`) — the formula cels + knobs dehydrate as ordinary JSON. "The rule," shareable
  independent of any frozen grid.
- *Snapshot* (`甲骨.json`) — `sim.buffers` holds typed arrays, which the **default dehydrate does NOT
  round-trip** (`dehydrate/schema.ts` is JSON-only). Register a custom schema `dehydrate`/`hydrate`
  pair — base64 the `ArrayBuffer`, or reuse `reference/binary.js`. Stash `rNums/rC/cC` to keep
  onecell's deterministic replay.

---

## 6. The scheduling prize: learn / lock / lose

**This is the part to mine hardest.** onecell does not use `requestAnimationFrame` or a fixed
interval. `watchTimer()` *learns a cost model* of how long a tick takes at each achieved FPS
(`fpsLimit`, `fpsMap`) and adapts `gravAdjust`/`gravTimeout` toward `fpsMax`. The `[y]` key cycles
three modes:

```js
let timerMode = [ 'learn', 'lock', 'lose' ];  // build the model / freeze it / reset to neutral
```

The lessons, generalised:

1. **Decouple three rates** — simulation rate, render rate, and device capability — via a feedback
   controller, not a fixed clock.
2. **The controller has a learnable model** (cost per FPS bucket), a **lock** (freeze once tuned), and
   a **reset**. That's a tiny PID-ish governor.

**Absorb it as a cel group.** `sim.frame_cost` (measured ValueCel, written by the host each frame) →
`sim.interval` (FormulaCel/fn governor) read by the host loop to schedule the next frame.
`timer_mode` knob gates whether `frame_cost` updates the model.

```ts
let interval = 16;
const frame = async () => {
  const t0 = performance.now();
  await resolveFn(state, "sim.step")(state);
  await resolveFn(state, "runCycle")(state);              // recompute active_rule, thresholds, sim.interval
  await resolveFn(state, "drain")(state, "three.paint");  // genuine IO
  await setValue(state, "sim.frame_cost", performance.now() - t0);
  interval = Number(state.cels.get("sim.interval")!.v);   // the governor's output
  setTimeout(frame, interval);
};
```

**This generalises beyond onecell.** Any plastron host with heavy continuous recompute (live formula
recalc on animation, this sim, a particle system) wants this. `origin-main.ts` already hand-rolls
`setInterval` clock + viewport-sync loops that would consume a shared governor. **If the cel version
proves out, propose extracting it into a library segment** (a `scheduler`/`clock` segment) rather than
leaving it onecell-local. Flag that in the findings doc.

---

## 7. Paint is a drain effect, not vnode propagation

Rendering 262k instances is genuine IO → a **channel drain** (`drain(state, "three.paint")`), which is
how our doctrine reserves imperative repaint. **Do not** route it through the kernel's `dom.paint`
vnode-diffing path (`dom/utils/paint.ts`) — that's for DOM trees, wrong tool for an `InstancedMesh`.
Register your own painter effect that reads `sim.buffers` + visual knobs and does onecell's
`updateInstances` (keep the `cells[n] != posns[n]` diff — but now it fires only when `sim.generation`
or a visual knob changed, instead of hand-managed `needsUpdate` flags). **This is the natural seam to
the GPU/geometry/canvas work you're already doing** — the painter effect is where your instanced-mesh
substrate plugs in.

## 8. Known traps (grounded in the kernel source)

- **The kernel rejects dependency cycles** (`卜/topo.ts` Kahn; `卜/precompute.ts` throws `CycleError`).
  The graph is a strict DAG. onecell's population↔rule feedback (`total_alive → active_rule → … →
  total_alive`) **must not be wired as edges** — it closes through the **host frame**: `sim.step`
  reads *last frame's* `active_rule` value imperatively and writes `total_alive`; `runCycle` recomputes
  `active_rule` ready for next frame. This is exactly origin's clock pattern (`origin-main.ts:24-33`).
- **Typed arrays don't survive the default dehydrate** — JSON only. Custom schema protocol required
  (§5).
- **Native fns read cels via `state.cels.get(key)?.v`**; resolve fns via `resolveFn(state, key)` which
  returns `cel._fn` (`kernel/resolve-fn.ts`). There is no `state.fns` map — the cel registry is the
  dispatch surface.
- **`setValue` = data plane** (ValueCel `.v` / FormulaCel `.f`, recalc tier). **`setCel` = structure**
  (create/replace whole cel with `celType`, recompile tier). Don't cross them.

## 9. Plastron idiom cheat-sheet (so you don't rediscover it)

```ts
import { createInitialState, precompute, resolveFn } from "plastron";
const state    = createInitialState();
const hydrate  = resolveFn(state, "hydrate")  as Fn;  // async
const runCycle = resolveFn(state, "runCycle") as Fn;
const getCel   = resolveFn(state, "getCel")   as Fn;  // returns live Cel; take .v
const setValue = resolveFn(state, "setValue") as Fn;  // data plane
const setCel   = resolveFn(state, "setCel")   as Fn;  // cel plane

// read a cel value inside a native fn:
const v = state.cels.get("sim.total_alive")?.v;

// create a value cel:
await setCel(state, "neighbor_range",
  { celType: "ValueCel", v: 3, metadata: { key: "neighbor_range", segment: "sim", name: "neighbor_range" } });

// host frame (origin pattern):
await resolveFn(state, "runCycle")(state);
await resolveFn(state, "drain")(state, "three.paint");
```

(Confirmed against `kernel/契/value.ts`, `kernel/契/cel.ts`, `kernel/resolve-fn.ts`,
`甲骨坑/library/dom/utils/paint.ts`, `plastron-examples/origin/origin-main.ts`,
`plastron-examples/origin/e2e/run.ts`.)

---

## 10. Deliverables & evaluation rubric

Build under `plastron-examples/onecell/`:

1. **`twoCels/`** — the two-cel version (§4).
2. **`manyCels/`** — the full version (§5).
3. **`FINDINGS.md`** — the actual point of the exercise. Answer, with measurements:

   | Axis | Question |
   |---|---|
   | Granularity break-even | At which cel count did the graph start *helping*? Was twoCels already past it? |
   | Bug surface | Did auto-wired deps remove the manual-re-derive class of bug (onecell's acknowledged neighbour desync)? |
   | Perf — step | ms/frame for `applicationTick` (must be ≈ identical to onecell; the kernel is only the boundary). |
   | Perf — graph | runCycle + drain overhead per frame. Is it ~0 with only boundary cels? Quantify. |
   | Cycle friction | Was the host-tick feedback workaround (§8) clean, or a smell? |
   | Snapshot | Did recipe/snapshot split work? How painful was typed-array dehydration? |
   | Scheduling | Did modelling the governor as a cel help, or was it better imperative? **Should it be a shared library segment?** |
   | Multi-observer | Confirm/refute the twoCels headline: is a 2nd/3rd consumer of `world` genuinely one line? |

   The honest answer might be "plastron hurt below N cels and helped above it" — that's the finding we
   want. Don't force a verdict; report the curve.

## 11. Coordination

- Reference source is vendored in `reference/` (do not edit — it's the baseline to diff against).
- The painter effect (§7) is the seam to your GPU/geometry/canvas substrate — wire it there.
- When `FINDINGS.md` lands, ping for a doctrine update: this experiment is meant to refine the
  cel-granularity guidance in `CLAUDE.md` and decide whether the scheduler graduates to a library
  segment.
