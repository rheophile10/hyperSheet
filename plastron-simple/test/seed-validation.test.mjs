import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, validateManifests } from "../dist/index.js";

// The boot path (createInitialState) seeds state.segments straight from
// 冊.json WITHOUT running validateManifests — which is how the old
// 22-dependency "kernel" manifest violation survived undetected. This
// test is how the seed stays honest: it runs the validator the boot
// path skips against the freshly-seeded manifests and asserts it does
// not throw. validateManifests mutates manifests in place via
// applyManifestDefaults (stamping role) — fine; these are per-State
// copies created by createInitialState.
test("the boot seed (冊.json) passes validateManifests", () => {
  const state = createInitialState();
  assert.doesNotThrow(() =>
    validateManifests(state, [...state.segments.values()]),
  );
});
