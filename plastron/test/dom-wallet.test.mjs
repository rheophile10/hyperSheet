import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";

// dom-wallet — the unsafe-wallet panel authored as dom() formulas. domWallet is
// a PURE render fn over the wallet's reader verbs: =domWallet(locked(walletNote),
// apiKeys()). It builds an equivalent panel to unsafe-wallet's hand-built
// walletFn, but through the dom()/style()/attr()/on() vocabulary, wiring the
// SAME wallet.* dispatch handlers. These kernel-level (no-browser) tests fire
// domWallet against a locked wallet then an unlocked one and assert the returned
// vnode tree carries the unlock input (locked) / the lock button + add-key
// inputs (unlocked), with the wallet.* handlers bound on the right events.

// Walk a vnode tree collecting nodes that satisfy a predicate.
const find = (node, pred, out = []) => {
  if (!node || typeof node !== "object") return out;
  if (pred(node)) out.push(node);
  for (const k of node.children ?? []) find(k, pred, out);
  return out;
};
const text = (node) => find(node, (n) => n.type === "text").map((n) => n.text).join("");

test("locked → an unlock password input wired to wallet.unlock", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["dom-wallet"]);
  await precomputeOptional(state);

  const domWallet = resolveFn(state, "domWallet");
  // locked(walletNote) is true at boot; mirror that by passing true.
  const v = domWallet(true);

  assert.equal(v.type, "el");
  assert.equal(v.tag, "div");
  assert.match(text(v), /🔒 locked/);

  // an unlock <input type=password> whose change+keydown dispatch wallet.unlock
  const inputs = find(v, (n) => n.tag === "input");
  assert.equal(inputs.length, 1, "exactly one input in the locked panel");
  const inp = inputs[0];
  assert.equal(inp.attrs.type, "password");
  assert.equal(inp.events.change.dispatch, "wallet.unlock");
  assert.equal(inp.events.keydown.dispatch, "wallet.unlock");

  // no lock button while locked
  assert.equal(find(v, (n) => n.tag === "button").length, 0, "no buttons while locked");
});

test("a bare domWallet() (no lock arg) renders the locked panel", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["dom-wallet"]);
  await precomputeOptional(state);
  const v = resolveFn(state, "domWallet")();
  assert.match(text(v), /🔒 locked/);
  assert.equal(find(v, (n) => n.events?.change?.dispatch === "wallet.unlock").length, 1);
});

test("unlocked → lock button + add-key inputs + per-key delete, all wired to wallet.*", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["dom-wallet"]);
  await precomputeOptional(state);

  // unlock via the SAME handler the panel wires (reuse unsafe-wallet's test
  // setup pattern: a change event carrying the password). The first password
  // creates the wallet; storing a key flips apiKeys() to a real name list.
  const call = (k, ...a) => resolveFn(state, k)(state, ...a);
  await call("wallet.unlock", null, { type: "change", target: { value: "hunter2" } });
  assert.equal(resolveFn(state, "locked")(), false, "wallet is unlocked");
  await call("wallet.set", "anthropic", { type: "change", target: { value: "sk-ant-fake" } });

  // compose the panel exactly as the formula would: domWallet(locked, apiKeys())
  const names = resolveFn(state, "apiKeys")();
  assert.equal(names, "anthropic", "apiKeys() lists the NAME only");
  const v = resolveFn(state, "domWallet")(resolveFn(state, "locked")(), names);

  assert.equal(v.type, "el");
  assert.match(text(v), /🔓 unlocked — 1 key/);

  // a lock button → wallet.lock
  const lockBtns = find(v, (n) => n.tag === "button" && n.events?.click?.dispatch === "wallet.lock");
  assert.equal(lockBtns.length, 1, "one lock button wired to wallet.lock");
  assert.match(text(lockBtns[0]), /lock/);

  // the add-a-key row: a text name input → wallet.newName buffer (set listener),
  // and a password secret input → wallet.setNamed (dispatch on change+keydown)
  const nameInput = find(v, (n) => n.tag === "input" && n.attrs?.type === "text");
  assert.equal(nameInput.length, 1, "one name input");
  assert.equal(nameInput[0].events.input.set, "wallet.newName");
  assert.equal(nameInput[0].events.input.extract, "value");

  const secretInputs = find(v, (n) => n.tag === "input" && n.attrs?.type === "password");
  assert.equal(secretInputs.length, 1, "one add-key secret input");
  assert.equal(secretInputs[0].events.change.dispatch, "wallet.setNamed");
  assert.equal(secretInputs[0].events.keydown.dispatch, "wallet.setNamed");

  // a per-key chip with a ✕ delete button → wallet.del with the key NAME payload
  const delBtns = find(v, (n) => n.tag === "button" && n.events?.click?.dispatch === "wallet.del");
  assert.equal(delBtns.length, 1, "one delete button for the one stored key");
  assert.equal(delBtns[0].events.click.payload, "anthropic", "delete carries the key name");
  assert.match(text(v), /🔑 anthropic/);

  // clean up module-scope wallet state so the order of tests can't leak
  await call("wallet.del", "anthropic");
  await resolveFn(state, "wallet.lock")(state);
});
