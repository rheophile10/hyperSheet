import { test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// grok-chatdoc — the SHIPPED chat document (plastron-examples/origin/apps/docs/
// chatdoc.json), driven headless through the real install → 📂 picker → opendoc
// path (the same flow the dev server's baked archive takes in the browser):
//   • origin.install lands it in the segment store with an `app` stamp (that
//     stamp is what the 📂 picker lists);
//   • origin.opendoc opens a workbook — the recipe cells fire: B1's dict feeds
//     the derived sb.default config cel, B2's =addbot mints the roster bot,
//     B3's =view("chat", chatpane(…)) grows the chat pane;
//   • signed out, the pane is the appkit LOGIN card; flipping sb.default.auth
//     re-renders it to the chat through the graph (real auth needs credentials
//     — the live-surface twin is grok-live.test.mjs).

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-grok-chatdoc";

const { createInitialState, resolveFn } = await import("../dist/index.js");

const DOC_PATH = path.resolve(import.meta.dir, "../../plastron-examples/origin/apps/docs/chatdoc.json");
const chatdoc = JSON.parse(await fs.readFile(DOC_PATH, "utf8"));

const root = createInitialState().cels.get("file-store.root").v;
beforeEach(async () => { await fs.rm(path.resolve(root, "plastron"), { recursive: true, force: true }); });

const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["origin", "sheets", "window", "origin-lifecycle", "user-space-ops", "segment-store", "opfs-seeding"]);
  await resolveFn(s, "hydrate")(s, [], []);
  return s;
};
// the settle loop origin's own launch/open paths run after a structural change
const settle = async (s) => {
  const drain = resolveFn(s, "drain"), runCycle = resolveFn(s, "runCycle");
  for (let i = 0; i < 6; i++) {
    await runCycle(s);
    if (s.cels.get("genesis.commit")) await drain(s, "genesis.commit");
    if (s.cels.get("origin.effects")) await drain(s, "origin.effects");
  }
};
const v = (s, k) => s.cels.get(k)?.v;

test("chatdoc installs, lists in the 📂 picker, and opens with the chat pane login-gated", async () => {
  const s = await boot();
  await resolveFn(s, "origin.install")(s, chatdoc);

  // the 📂 picker's source: a stored doc entry carrying an `app` stamp
  const entries = await resolveFn(s, "store.list")(s);
  const entry = entries.find((e) => e.name === "chatdoc");
  assert.ok(entry, "chatdoc is in the segment store");
  assert.ok(entry.app, "…stamped as a document (the 📂 picker lists exactly these)");

  // the picker itself renders the row
  await resolveFn(s, "sheetapp.open")(s);
  assert.match(JSON.stringify(v(s, "win.sheetopen.content")), /📄 chatdoc/, "the picker shows the doc");

  // open it — the recipe cells fire
  await resolveFn(s, "origin.opendoc")(s, "chatdoc");
  await settle(s);

  // a workbook window hosts the chatdoc sheet
  const wbRef = [...s.cels.keys()].find((k) => {
    const st = s.cels.get(k)?.v;
    return k.endsWith(".state") && Array.isArray(st?.sheets) && st.sheets.some((t) => String(t.ref ?? "").includes("chatdoc"));
  });
  assert.ok(wbRef, "a workbook window opened over chatdoc");

  // B1 (the ONE public-config dict) → the derived sb.default cel sbConfig reads
  assert.equal(v(s, "chatdoc.B1").url, "http://127.0.0.1:54341", "B1 holds the appkit stack's URL");
  assert.equal(v(s, "sb.default")?.url, "http://127.0.0.1:54341", "sb.default derives from B1 (=chatdoc.B1)");
  assert.match(String(v(s, "sb.default")?.anonkey), /^sb_publishable_/, "the key is the PUBLISHABLE one");

  // B2 =addbot minted the roster bot by genesis
  assert.ok(v(s, "grok.roster.advisor"), "the advisor bot bloomed from B2");

  // B3 =view("chat", chatpane(…)) grew the pane; signed out → the LOGIN card
  const wbState = v(s, wbRef);
  assert.ok((wbState.views ?? []).length >= 1, "the workbook grew a view tab");
  const pane = JSON.stringify(v(s, "chat.view") ?? "");
  assert.match(pane, /gk-login/, "the chat pane is login-gated (appkit login card)");
  assert.match(pane, /grok\.signin/, "the Sign-in button dispatches grok.signin");

  // the recipe stays visible: B3 keeps its formula (the bar shows the source)
  assert.match(String(s.cels.get("chatdoc.B3")?.f ?? ""), /^=view\("chat", chatpane\(grok\.transcript/, "the chatpane formula IS the cell content");

  // signing in flips the SAME pane to the chat (write the auth cel the way
  // supabase-auth's writeAuth does; real credentials are the live test's job)
  await resolveFn(s, "setCel")(s, "sb.default.auth", { celType: "ValueCel", v: { status: "signed-in", email: "ian@example.com" }, metadata: { key: "sb.default.auth", segment: "supabase-auth", name: "default.auth" } });
  await settle(s);
  const pane2 = JSON.stringify(v(s, "chat.view") ?? "");
  assert.match(pane2, /gk-chat/, "signed in: the chat card, same view, re-rendered through the graph");
  assert.match(pane2, /@smith/, "the bestiary renders as header chips (roster bots route by @mention)");
});
