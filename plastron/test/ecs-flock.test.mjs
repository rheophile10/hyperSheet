import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// Tier A — the dense interior under the grid-program contract: swarmstep is
// pure MECHANISM (spatial hash, neighbor aggregates, integrate + wrap) and
// the steering RULE arrives as a kernel callable — in a real sheet, a lambda
// cel (=LAMBDA or wat); here, a plain JS fn with the same ABI. flockSeed is
// the deterministic seeding mechanism; the sim.run pump's EFFECT MODE
// advances buffers in place and only the generation crosses the graph.

const boot = () => {
  const state = createInitialState();
  return { state, f: (k) => resolveFn(state, k) };
};

const checksum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * (i % 7 + 1); return s; };

const PARAMS = { cohesion: 0.015, alignment: 0.05, separation: 0.06, maxSpeed: 2, radius: 1.2, dt: 0.016, w: 20, h: 12, d: 20 };

// The classic boids steering rule on the swarmstep kernel ABI — the JS twin
// of the demo sheet's E1 =LAMBDA / boids10k.steerwat wat cel.
const STEER = (px, py, pz, vx, vy, vz, n, cx, cy, cz, ax, ay, az, sx, sy, sz, coh, ali, sep, maxv) => {
  let wx = vx, wy = vy, wz = vz;
  if (n > 0) {
    wx += (cx - px) * coh + (ax - vx) * ali + sx * sep;
    wy += (cy - py) * coh + (ay - vy) * ali + sy * sep;
    wz += (cz - pz) * coh + (az - vz) * ali + sz * sep;
  }
  const speed = Math.max(0.000001, Math.hypot(wx, wy, wz));
  const k = Math.min(Math.max(speed, maxv * 0.3), maxv) / speed;
  return [wx * k, wy * k, wz * k];
};

test("flockSeed is deterministic (same seed → byte-identical flock)", () => {
  const { f } = boot();
  const a = f("flockSeed")(500, 42, 20, 12, 20);
  const b = f("flockSeed")(500, 42, 20, 12, 20);
  assert.equal(a.n, 500);
  assert.equal(a.positions.length, 1500);
  assert.deepEqual(Array.from(a.positions), Array.from(b.positions));
  assert.deepEqual(Array.from(a.velocities), Array.from(b.velocities));
  const c = f("flockSeed")(500, 43, 20, 12, 20);
  assert.notDeepEqual(Array.from(a.positions), Array.from(c.positions));
});

test("swarmstep is mechanism only: no kernel → a clear throw", () => {
  const { f } = boot();
  const buf = f("flockSeed")(50, 1, 20, 12, 20);
  assert.throws(() => f("swarmstep")(buf, PARAMS), /no kernel/);
});

test("swarmstep is deterministic across runs and preserves invariants", () => {
  const { f } = boot();
  const run = () => {
    const buf = f("flockSeed")(400, 7, 20, 12, 20);
    for (let t = 0; t < 60; t++) f("swarmstep")(buf, PARAMS, STEER);
    return buf;
  };
  const a = run(), b = run();
  assert.equal(checksum(a.positions), checksum(b.positions), "60 steps, same seed → identical positions");
  assert.equal(checksum(a.velocities), checksum(b.velocities));
  // invariants: in-box, speed clamped (the KERNEL's clamp — maxSpeed and the
  // 0.3 floor are its policy, and the mechanism must not second-guess it)
  for (let i = 0; i < a.n; i++) {
    const x = a.positions[i * 3], y = a.positions[i * 3 + 1], z = a.positions[i * 3 + 2];
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), "finite positions");
    assert.ok(Math.abs(x) <= 10.001 && Math.abs(y) <= 6.001 && Math.abs(z) <= 10.001, `in box (${x},${y},${z})`);
    const s = Math.hypot(a.velocities[i * 3], a.velocities[i * 3 + 1], a.velocities[i * 3 + 2]);
    assert.ok(s <= 2.0001, `speed clamped (${s})`);
    assert.ok(s >= 0.5999 * 0.999, `min speed holds (${s})`);
  }
});

test("the rule belongs to the kernel: two kernels → two flocks", () => {
  const { f } = boot();
  const a = f("flockSeed")(200, 3, 20, 12, 20);
  const b = f("flockSeed")(200, 3, 20, 12, 20);
  const DRIFT = (px, py, pz, vx, vy, vz) => [vx, vy, vz];   // no steering at all
  for (let t = 0; t < 30; t++) {
    f("swarmstep")(a, PARAMS, STEER);
    f("swarmstep")(b, PARAMS, DRIFT);
  }
  assert.notEqual(checksum(a.velocities), checksum(b.velocities), "same mechanism, different rule → different flock");
});

test("spatial hash agrees with a naive O(n²) reference (small n, one step)", () => {
  const { f } = boot();
  const n = 200;
  // the hash visits cells in z/y/x block order, not index order, so compare
  // at a radius small enough that no boid sees more than the cap (sparse).
  const sparse = { ...PARAMS, radius: 0.6 };
  const h2 = f("flockSeed")(n, 11, 20, 12, 20);
  const n2 = f("flockSeed")(n, 11, 20, 12, 20);
  f("swarmstep")(h2, sparse, STEER);
  stepNaive(n2, sparse);
  let maxDiff = 0;
  for (let i = 0; i < n2.positions.length; i++) maxDiff = Math.max(maxDiff, Math.abs(h2.positions[i] - n2.positions[i]));
  assert.ok(maxDiff < 1e-4, `hash ≡ naive within 1e-4 (got ${maxDiff})`);

  // naive reference — same KERNEL, brute-force neighbor aggregates
  function stepNaive(buf, p) {
    const N = buf.n, pos = buf.positions, vel = buf.velocities;
    const r2 = p.radius * p.radius;
    const vnext = new Float32Array(3 * N);
    for (let i = 0; i < N; i++) {
      const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
      const vx = vel[i * 3], vy = vel[i * 3 + 1], vz = vel[i * 3 + 2];
      let cx = 0, cy = 0, cz = 0, avx = 0, avy = 0, avz = 0, sx = 0, sy = 0, sz = 0, found = 0;
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const ox = pos[j * 3] - px, oy = pos[j * 3 + 1] - py, oz = pos[j * 3 + 2] - pz;
        const d2 = ox * ox + oy * oy + oz * oz;
        if (d2 > r2) continue;
        cx += pos[j * 3]; cy += pos[j * 3 + 1]; cz += pos[j * 3 + 2];
        avx += vel[j * 3]; avy += vel[j * 3 + 1]; avz += vel[j * 3 + 2];
        const inv = 1 / Math.max(0.01, d2);
        sx -= ox * inv; sy -= oy * inv; sz -= oz * inv;
        found++;
      }
      const m = found > 0 ? 1 / found : 0;
      const w = STEER(px, py, pz, vx, vy, vz, found,
        cx * m, cy * m, cz * m, avx * m, avy * m, avz * m, sx, sy, sz,
        p.cohesion, p.alignment, p.separation, p.maxSpeed);
      vnext[i * 3] = w[0]; vnext[i * 3 + 1] = w[1]; vnext[i * 3 + 2] = w[2];
    }
    const wrap1 = (v, span) => { const half = span / 2; let x = (v + half) % span; if (x < 0) x += span; return x - half; };
    for (let i = 0; i < N; i++) {
      vel[i * 3] = vnext[i * 3]; vel[i * 3 + 1] = vnext[i * 3 + 1]; vel[i * 3 + 2] = vnext[i * 3 + 2];
      pos[i * 3] = wrap1(pos[i * 3] + vel[i * 3] * p.dt, p.w);
      pos[i * 3 + 1] = wrap1(pos[i * 3 + 1] + vel[i * 3 + 1] * p.dt, p.h);
      pos[i * 3 + 2] = wrap1(pos[i * 3 + 2] + vel[i * 3 + 2] * p.dt, p.d);
    }
  }
});

test("bufstats probes the dense interior through the grid", () => {
  const { f } = boot();
  const buf = f("flockSeed")(300, 9, 20, 12, 20);
  const s0 = f("bufstats")(buf, 0);
  assert.equal(s0.n, 300);
  assert.equal(s0.gen, 0);
  assert.ok(s0.meanSpeed > 0 && s0.maxSpeed >= s0.meanSpeed, `sane stats (${s0.meanSpeed}, ${s0.maxSpeed})`);
  for (let t = 0; t < 20; t++) f("swarmstep")(buf, PARAMS, STEER);
  const s1 = f("bufstats")(buf, 20);
  assert.equal(s1.gen, 20, "gen is part of the output — the stats are as-of a generation");
  assert.ok(s1.maxSpeed <= PARAMS.maxSpeed + 1e-3, "probe sees the kernel's clamp");
  assert.equal(f("bufstats")({}, 5).n, 0, "empty buffer probes as zeros, not a throw");
});

test("pump effect mode: CALLABLES for fn/kernel/init, in-place mutation, gen bump; stop + while-gate", async () => {
  const { state, f } = boot();
  const seg = {
    name: "flocktest", version: "0.0.1", dependencies: ["ecs"], role: "library",
    cels: [
      { key: "fl.buffers", celType: "ValueCel", metadata: { key: "fl.buffers", segment: "flocktest" }, v: {} },
      { key: "fl.gen", celType: "ValueCel", metadata: { key: "fl.gen", segment: "flocktest" }, v: 0 },
      { key: "fl.params", celType: "ValueCel", metadata: { key: "fl.params", segment: "flocktest" }, v: PARAMS },
      { key: "fl.pump", celType: "ValueCel", metadata: { key: "fl.pump", segment: "flocktest" }, v: 0 },
    ],
  };
  await f("hydrate")(state, [seg], [{ name: "flocktest", version: "0.0.1", dependencies: seg.dependencies, role: "library" }]);

  // the config's fn/kernel/init are CALLABLES (in a sheet, cel references —
  // the grid-program contract's R4: no string-dispatched functions)
  await f("setValue")(state, "fl.pump", { fps: 60, effects: [
    { fn: f("swarmstep"), kernel: STEER, buffers: "fl.buffers", params: "fl.params", gen: "fl.gen", init: f("flockSeed"), initArgs: [300, 5, 20, 12, 20] },
  ] });

  assert.equal(f("sim.run")(state, "fl.pump"), "running");
  await new Promise((r) => setTimeout(r, 150));
  const buf = state.cels.get("fl.buffers").v;
  assert.ok(buf.positions instanceof Float32Array, "init seeded the buffers");
  assert.equal(buf.positions.length, 900);
  const gen1 = state.cels.get("fl.gen").v;
  assert.ok(gen1 >= 2, `generation advanced (${gen1})`);
  const snap = checksum(buf.positions);
  await new Promise((r) => setTimeout(r, 100));
  assert.notEqual(checksum(state.cels.get("fl.buffers").v.positions), snap, "buffers mutate in place across frames");

  assert.equal(f("sim.stop")(state, "fl.pump"), "stopping");
  await new Promise((r) => setTimeout(r, 80));
  const genStopped = state.cels.get("fl.gen").v;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(state.cels.get("fl.gen").v, genStopped, "stopped pump advances nothing");

  // while-gate: a config whose window cel is closed never starts ticking
  await f("setCel")(state, "fl.win", { celType: "ValueCel", v: { closed: 1 }, metadata: { segment: "flocktest" } });
  await f("setValue")(state, "fl.pump", { fps: 60, while: "fl.win", effects: [
    { fn: f("swarmstep"), kernel: STEER, buffers: "fl.buffers", params: "fl.params", gen: "fl.gen" },
  ] });
  assert.equal(f("sim.run")(state, "fl.pump"), "running");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(state.cels.get("fl.gen").v, genStopped, "while-gate blocked the closed-window pump");
});
