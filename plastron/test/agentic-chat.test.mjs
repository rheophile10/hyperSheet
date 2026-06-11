import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, setAccessPolicy, canSet } from "../dist/index.js";

// capability D — the bot edits ITS chat's segment, confined by Layer 1.
test("chat.run applies the bot's commands to the CHAT segment only", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["windows"]);
  await resolveFn(state, "setCel")(state, "chat.t.log", { celType: "ValueCel", v: [], metadata: { key: "chat.t.log", segment: "win.chat-t", name: "log" } });
  setAccessPolicy(state, "win.chat-t", { get: "public", set: "private" });
  await resolveFn(state, "chat.run")(state, "t", [{ op: "cel", key: "note", value: "hi" }, { op: "msg", text: "done" }]);
  assert.equal(state.cels.get("chat.t.note")?.v, "hi", "the bot's value cel was created");
  assert.equal((state.cels.get("chat.t.note")?.metadata)?.segment, "win.chat-t", "scoped to the chat's segment");
  // the bot's accessor (the chat segment) cannot write a foreign sealed segment
  setAccessPolicy(state, "wallet", { get: "public", set: "private", setSealed: true });
  assert.equal(canSet(state, "win.chat-t", "wallet"), false, "the chat accessor is sealed out of the wallet — commands can't escape");
});
