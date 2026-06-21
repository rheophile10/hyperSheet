import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";

// vault — the secrets panel authored as dom() formulas. secrets() is a PURE
// render fn over the vault's reader verbs: =secrets(locked(secretsNote),
// apiKeys()). It builds the panel through the dom()/style()/attr()/on()
// vocabulary, wiring the vault.* dispatch handlers. These kernel-level
// (no-browser) tests fire secrets() against a locked vault then an unlocked one
// and assert the returned vnode tree carries the unlock input (locked) / the
// lock button + add-key inputs (unlocked), with the vault.* handlers bound on
// the right events.

// Walk a vnode tree collecting nodes that satisfy a predicate.
const find = (node, pred, out = []) => {
  if (!node || typeof node !== "object") return out;
  if (pred(node)) out.push(node);
  for (const k of node.children ?? []) find(k, pred, out);
  return out;
};
const text = (node) => find(node, (n) => n.type === "text").map((n) => n.text).join("");

test("locked → an unlock password input wired to vault.unlock", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["vault"]);
  await precomputeOptional(state);

  const secrets = resolveFn(state, "secrets");
  // locked(secretsNote) is true at boot; mirror that by passing true.
  const v = secrets(true);

  assert.equal(v.type, "el");
  assert.equal(v.tag, "div");
  assert.match(text(v), /🔒 locked/);

  // an unlock <input type=password> whose change+keydown dispatch vault.unlock
  const inputs = find(v, (n) => n.tag === "input");
  assert.equal(inputs.length, 1, "exactly one input in the locked panel");
  const inp = inputs[0];
  assert.equal(inp.attrs.type, "password");
  assert.equal(inp.events.change.dispatch, "vault.unlock");
  assert.equal(inp.events.keydown.dispatch, "vault.unlock");

  // no lock button while locked
  assert.equal(find(v, (n) => n.tag === "button").length, 0, "no buttons while locked");
});

test("a bare secrets() (no lock arg) renders the locked panel", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["vault"]);
  await precomputeOptional(state);
  const v = resolveFn(state, "secrets")();
  assert.match(text(v), /🔒 locked/);
  assert.equal(find(v, (n) => n.events?.change?.dispatch === "vault.unlock").length, 1);
});

test("unlocked → lock button + add-key inputs + per-key delete, all wired to vault.*", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["vault"]);
  await precomputeOptional(state);

  // unlock via the SAME handler the panel wires: a change event carrying the
  // password. The first password creates the vault; storing a key flips
  // apiKeys() to a real name list.
  const call = (k, ...a) => resolveFn(state, k)(state, ...a);
  await call("vault.unlock", null, { type: "change", target: { value: "hunter2" } });
  assert.equal(resolveFn(state, "locked")(), false, "vault is unlocked");
  await call("vault.set", "anthropic", { type: "change", target: { value: "sk-ant-fake" } });

  // compose the panel exactly as the formula would: secrets(locked, apiKeys())
  const names = resolveFn(state, "apiKeys")();
  assert.equal(names, "anthropic", "apiKeys() lists the NAME only");
  const v = resolveFn(state, "secrets")(resolveFn(state, "locked")(), names);

  assert.equal(v.type, "el");
  assert.match(text(v), /🔓 unlocked — 1 key/);

  // a lock button → vault.lock
  const lockBtns = find(v, (n) => n.tag === "button" && n.events?.click?.dispatch === "vault.lock");
  assert.equal(lockBtns.length, 1, "one lock button wired to vault.lock");
  assert.match(text(lockBtns[0]), /lock/);

  // the add-a-key row: a text name input → vault.newName buffer (set listener),
  // and a password secret input → vault.setNamed (dispatch on change+keydown)
  const nameInput = find(v, (n) => n.tag === "input" && n.attrs?.type === "text");
  assert.equal(nameInput.length, 1, "one name input");
  assert.equal(nameInput[0].events.input.set, "vault.newName");
  assert.equal(nameInput[0].events.input.extract, "value");

  const secretInputs = find(v, (n) => n.tag === "input" && n.attrs?.type === "password");
  assert.equal(secretInputs.length, 1, "one add-key secret input");
  assert.equal(secretInputs[0].events.change.dispatch, "vault.setNamed");
  assert.equal(secretInputs[0].events.keydown.dispatch, "vault.setNamed");

  // a per-key chip with a ✕ delete button → vault.del with the key NAME payload
  const delBtns = find(v, (n) => n.tag === "button" && n.events?.click?.dispatch === "vault.del");
  assert.equal(delBtns.length, 1, "one delete button for the one stored key");
  assert.equal(delBtns[0].events.click.payload, "anthropic", "delete carries the key name");
  assert.match(text(v), /🔑 anthropic/);

  // clean up module-scope vault state so the order of tests can't leak
  await call("vault.del", "anthropic");
  await resolveFn(state, "vault.lock")(state);
});
