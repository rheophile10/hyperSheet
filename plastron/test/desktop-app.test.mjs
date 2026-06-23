import { test } from "bun:test";
import assert from "node:assert/strict";

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-desktop";

const { createInitialState, resolveFn } = await import("../dist/index.js");
const origin = await import("../dist/甲骨坑/application/origin/index.js");

// origin is parked by default; wake it so the desktop chrome verbs resolve.
const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["origin"]);
  await resolveFn(s, "hydrate")(s, [], []);
  return s;
};

test("taskbarGenesis rebuilds the taskbar frame, splicing in each window's state cel", async () => {
  const s = await boot();
  const gen = resolveFn(s, "desktop.taskbarGenesis")(["win.a.state", "win.b.state"], "win.a.state");
  assert.equal(gen.genesis, true, "is a genesis request");
  assert.equal(gen.layer, "desktop.taskbar");
  const frame = gen.cels["desktop.taskbar.frame"];
  assert.ok(frame, "frame cel minted");
  assert.match(frame.f, /taskbarBar win\.active/, "renders taskbarBar over win.active");
  assert.match(frame.f, /win\.a\.state/, "references window a's state cel");
  assert.match(frame.f, /win\.b\.state/, "references window b's state cel");
});

test("taskbarGenesis drops non-key refs (formula-injection safe)", async () => {
  const s = await boot();
  const gen = resolveFn(s, "desktop.taskbarGenesis")(["win.ok.state", "evil ref)"], "");
  const f = gen.cels["desktop.taskbar.frame"].f;
  assert.match(f, /win\.ok\.state/, "the valid ref survives");
  assert.doesNotMatch(f, /evil/, "the malformed ref is dropped");
});

test("taskbarBar: a chip per open window; active bordered, min dimmed, closed/docked skipped", async () => {
  const s = await boot();
  const bar = resolveFn(s, "taskbarBar")(
    "win.a.state",
    { ref: "win.a.state", title: "Alpha" },
    { ref: "win.b.state", title: "Beta", min: 1 },
    { ref: "win.c.state", title: "Gamma", closed: 1 },
    { ref: "win.d.state", title: "Delta", dockedIn: "win.a.state" },
  );
  const chips = bar.children;
  assert.equal(chips.length, 2, "only Alpha + Beta render (Gamma closed, Delta docked)");
  const cls = chips.map((c) => String(c.attrs.class));
  assert.ok(cls.some((c) => c.includes("active")), "the active window's chip is .active");
  assert.ok(cls.some((c) => c.includes("min")), "the minimized window's chip is .min");
});

test("buildStateGraphSpec: one node per segment, sized by memory, origin-applications tinted distinctly", async () => {
  const s = await boot();
  const spec = origin.buildStateGraphSpec(s);
  const byKey = new Map(spec.nodes.map((n) => [n.key, n]));

  assert.ok(byKey.has("origin"), "origin is a node");
  const o = byKey.get("origin");
  assert.equal(o.kind, "app", "origin (role application) → kind app");
  assert.equal(o.accent, "#e8923a", "app accent tint");

  const plainSeg = [...byKey.values()].find((n) => n.kind === "segment");
  assert.ok(plainSeg, "at least one non-app (library) segment node");
  assert.equal(plainSeg.accent, "#4a90d9", "non-app accent tint");

  for (const n of spec.nodes) assert.ok(n.size >= 0.7 && n.size <= 2.0001, `${n.key} size in 0.7..2 band`);

  const keys = new Set(spec.nodes.map((n) => n.key));
  for (const [a, b] of spec.edges) assert.ok(keys.has(a) && keys.has(b), "edge endpoints are present nodes");

  // memory ordering: origin (a large segment) outweighs a tiny one → larger node
  const sizes = spec.nodes.map((n) => n.size);
  assert.ok(Math.max(...sizes) > Math.min(...sizes), "memory variation produces size variation");
});
