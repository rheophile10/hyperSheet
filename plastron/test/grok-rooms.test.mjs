import { test, afterAll } from "bun:test";
import assert from "node:assert/strict";

// grok-rooms — the appkit CHATROOMS surface (chatrooms.json): loginpane /
// roomspane / the room-chat chatpane wiring, and the room verb family
// (grok.loadrooms / pickroom / loadmsgs / roomsend / roomkey) against a STUB
// PostgREST + functions server shaped like appkit's schema (conversation +
// conversation_member + chat + profile + the list_conversations RPC + the
// bot-responder mention contract). No real APIs. The live twins (real local
// stack, skip-gated) are at the bottom.

const { createInitialState, precomputeOptional, resolveFn } = await import("../dist/index.js");

// ── stub appkit backend ──────────────────────────────────────────────────────
const LOUNGE = "00000000-0000-0000-0000-000000000001";
const calls = { inserts: [], responder: [], rpc: 0 };
let msgRows = [
  { id: 1, conversation_id: LOUNGE, author_id: "me-1", body: "hello room", format: "plain", created_at: "2026-07-06T10:00:00Z" },
  { id: 2, conversation_id: LOUNGE, author_id: "peer-2", body: "hi back", format: "plain", created_at: "2026-07-06T10:01:00Z" },
  { id: 3, conversation_id: LOUNGE, author_id: "peer-2", body: '{"title":"do a thing"}', format: "task", created_at: "2026-07-06T10:02:00Z" },
];
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/rest/v1/rpc/list_conversations" && req.method === "POST") {
      calls.rpc++;
      return Response.json([
        { id: LOUNGE, kind: "lounge", title: "Lounge", member_ids: [], last_body: "hi back", last_at: "2026-07-06T10:01:00Z", unread: 2 },
        { id: "dm-77", kind: "dm", title: null, member_ids: ["me-1", "peer-2"], last_body: "psst", last_at: "2026-07-06T09:00:00Z", unread: 0 },
      ]);
    }
    if (u.pathname === "/rest/v1/profile" && req.method === "GET") {
      return Response.json([{ id: "me-1", name: "Ian" }, { id: "peer-2", name: "Ada" }]);
    }
    if (u.pathname === "/rest/v1/chat" && req.method === "GET") {
      const conv = String(u.searchParams.get("conversation_id") ?? "");
      return Response.json(msgRows.filter((r) => `eq.${r.conversation_id}` === conv));
    }
    if (u.pathname === "/rest/v1/chat" && req.method === "POST") {
      const rows = await req.json();
      calls.inserts.push({ rows, auth: req.headers.get("authorization"), apikey: req.headers.get("apikey") });
      const inserted = rows.map((r, i) => ({ id: 100 + msgRows.length + i, format: "plain", created_at: new Date().toISOString(), ...r }));
      msgRows = [...msgRows, ...inserted];
      return Response.json(inserted);
    }
    if (u.pathname === "/functions/v1/bot-responder" && req.method === "POST") {
      calls.responder.push(await req.json().catch(() => ({})));
      return Response.json({ posted: "stub-bot" });
    }
    return new Response("not found", { status: 404 });
  },
});
const STUB_URL = `http://127.0.0.1:${stub.port}`;

const boot = async (signedIn = true) => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["grok", "supabase", "supabase-auth", "session", "sheets", "window"]);
  await resolveFn(s, "hydrate")(s, [], []);
  await precomputeOptional(s);
  await resolveFn(s, "runCycle")(s);
  const put = (k, v, seg = "supabase") => resolveFn(s, "setCel")(s, k, { celType: "ValueCel", v, metadata: { key: k, segment: seg, name: k.split(".").slice(1).join(".") } });
  await put("sb.default", { url: STUB_URL, anonkey: "stub-anon" }); // the ONE dict cel
  if (signedIn) await put("sb.default.auth", { status: "signed-in", email: "ian@test.local", userId: "me-1" }, "supabase-auth");
  return s;
};
const F = (s, k) => resolveFn(s, k);
const v = (s, k) => s.cels.get(k)?.v;

// ── room list ────────────────────────────────────────────────────────────────

test("grok.loadrooms shapes the RPC rows (DM titles from peers) into grok.rooms", async () => {
  const s = await boot();
  const rooms = await F(s, "grok.loadrooms")(s, "default");
  assert.equal(rooms.length, 2);
  assert.deepEqual(rooms[0], { id: LOUNGE, kind: "lounge", title: "Lounge", last_body: "hi back", last_at: "2026-07-06T10:01:00Z", unread: 2 });
  assert.equal(rooms[1].title, "Ada", "the DM title derives from the OTHER member's profile name");
  assert.deepEqual(v(s, "grok.rooms"), rooms, "…written to the grok.rooms cel");
  assert.deepEqual(v(s, "grok.peers"), { "me-1": "Ian", "peer-2": "Ada" }, "profile map loaded alongside");
});

test("roomspane renders clickable rows (icon, title, snippet, unread) dispatching grok.pickroom", async () => {
  const s = await boot();
  await F(s, "grok.loadrooms")(s, "default");
  const pane = JSON.stringify(F(s, "roomspane")(v(s, "grok.rooms"), { project: "default", authed: true, room: LOUNGE }));
  assert.match(pane, /gk-rooms/);
  assert.match(pane, /🏛/, "lounge icon");
  assert.match(pane, /Lounge/);
  assert.match(pane, /hi back/, "last-message snippet");
  assert.match(pane, /"grok\.pickroom","payload":"00000000-0000-0000-0000-000000000001"/, "row click dispatches grok.pickroom with the room id");
  assert.match(pane, /grok\.loadrooms/, "the ↻ Refresh button dispatches grok.loadrooms");
  assert.match(pane, /gk-room-row active/, "the selected room's row is highlighted");
  assert.match(pane, /👤/, "dm icon");
  assert.match(pane, /Ada/, "dm titled by the other member");
  // signed out → the gate hint, not the rows
  const gated = JSON.stringify(F(s, "roomspane")([], { authed: false }));
  assert.match(gated, /Sign in \(login view\)/);
});

test("loginpane: login card signed out; session card (email + Sign out) signed in", async () => {
  const s = await boot();
  const out = JSON.stringify(F(s, "loginpane")({ project: "default", authed: false, email: "", password: "", status: "signed-out" }));
  assert.match(out, /gk-login/, "signed out: the appkit login card");
  assert.match(out, /grok\.signin/);
  const inn = JSON.stringify(F(s, "loginpane")({ project: "default", authed: true, session: v(s, "sb.default.auth") }));
  assert.match(inn, /gk-session/, "signed in: the session card");
  assert.match(inn, /Signed in as ian@test\.local/);
  assert.match(inn, /grok\.signout/, "…with the Sign out dispatch");
});

// ── select a room and go into chat ───────────────────────────────────────────

test("grok.pickroom selects, loads + maps messages, and focuses the roomchat view tab", async () => {
  const s = await boot();
  await F(s, "grok.loadrooms")(s, "default");
  // a workbook window hosting a roomchat view tab (the =view drain's ref shape)
  await resolveFn(s, "setCel")(s, "win.wb9.state", { celType: "ValueCel", v: {
    ref: "win.wb9.state", sheets: [{ ref: "win.wb9.view.chatrooms", title: "chatrooms" }],
    views: [{ ref: "win.wb9.view.rooms", title: "rooms" }, { ref: "win.wb9.view.roomchat", title: "roomchat" }], aview: 0,
  }, metadata: { key: "win.wb9.state", segment: "win.wb9", name: "state" } });
  await F(s, "grok.pickroom")(s, LOUNGE);
  assert.equal(v(s, "grok.room"), LOUNGE);
  assert.equal(v(s, "grok.roomtitle"), "Lounge");
  const log = v(s, "grok.roomlog");
  assert.equal(log.length, 3);
  assert.deepEqual({ role: log[0].role, text: log[0].text }, { role: "user", text: "hello room" }, "MY row maps to a user bubble");
  assert.deepEqual({ role: log[1].role, bot: log[1].bot, human: log[1].human }, { role: "assistant", bot: "Ada", human: true }, "a peer's row maps to their profile name, marked human");
  assert.match(log[2].text, /^\[task\] /, "a structured format shows as a tagged snippet");
  assert.ok(log[0].ts > 0, "timestamps parse");
  assert.equal(v(s, "win.wb9.state").aview, 1, "the roomchat view tab was focused (go into chat)");
  // the room-chat pane renders the mapped log with 👤 for the peer
  const pane = JSON.stringify(F(s, "chatpane")(log, "", { authed: true, title: v(s, "grok.roomtitle"), draftCel: "grok.roomq", send: "grok.roomsend", key: "grok.roomkey", chips: false }));
  assert.match(pane, /Lounge/, "the header names the room");
  assert.match(pane, /👤 Ada/, "peers are people, not bots");
  assert.match(pane, /grok\.roomsend/, "Send wires to the room verb");
  assert.match(pane, /grok\.roomq/, "the composer writes the room buffer");
  assert.ok(!pane.includes("gk-bot-chip"), "chips:false — no bot chips in a human room");
});

// ── send ─────────────────────────────────────────────────────────────────────

test("grok.roomsend INSERTs as me, reloads the log, and only @*mentions summon bot-responder", async () => {
  const s = await boot();
  await F(s, "grok.loadrooms")(s, "default");
  await F(s, "grok.pickroom")(s, LOUNGE);
  const nInserts = calls.inserts.length, nResp = calls.responder.length;
  await F(s, "grok.field")(s, "grok.roomq", { target: { value: "plain human message" } });
  await F(s, "grok.roomsend")(s, "default");
  assert.equal(calls.inserts.length, nInserts + 1);
  assert.deepEqual(calls.inserts.at(-1).rows, [{ conversation_id: LOUNGE, author_id: "me-1", body: "plain human message" }],
    "the insert payload: the selected room, MY auth uid, the body (RLS shape)");
  assert.equal(v(s, "grok.roomq"), "", "composer cleared");
  assert.equal(calls.responder.length, nResp, "no @*mention → bot-responder NOT invoked");
  const log = v(s, "grok.roomlog");
  assert.equal(log.at(-1).text, "plain human message", "poll-on-send: the log reloaded with my message");
  assert.equal(log.at(-1).role, "user");
  // an @*mention fires the appkit bot contract with the NEW chat id
  await F(s, "grok.field")(s, "grok.roomq", { target: { value: "@*grok what is 2+2?" } });
  await F(s, "grok.roomsend")(s, "default");
  assert.equal(calls.responder.length, nResp + 1, "@*handle → bot-responder invoked");
  assert.equal(calls.responder.at(-1).chat_id, calls.inserts.at(-1) && msgRows.at(-1).id, "…with the inserted message's chat_id");
});

test("grok.roomsend gates cleanly: no room / not signed in → status, no insert", async () => {
  const s = await boot(false); // signed out
  await F(s, "grok.field")(s, "grok.roomq", { target: { value: "into the void" } });
  const n = calls.inserts.length;
  await F(s, "grok.roomsend")(s, "default");
  assert.equal(calls.inserts.length, n, "nothing inserted");
  assert.match(String(v(s, "grok.status")), /pick a room first/, "no room selected surfaces first");
  await resolveFn(s, "setValue")(s, "grok.room", LOUNGE);
  await F(s, "grok.roomsend")(s, "default");
  assert.equal(calls.inserts.length, n, "still nothing inserted");
  assert.match(String(v(s, "grok.status")), /sign in first/, "signed-out send is gated");
});

test("grok.roomkey: Enter sends to the ROOM, Shift+Enter does not", async () => {
  const s = await boot();
  await F(s, "grok.loadrooms")(s, "default");
  await F(s, "grok.pickroom")(s, LOUNGE);
  const n = calls.inserts.length;
  await F(s, "grok.field")(s, "grok.roomq", { target: { value: "enter-sent" } });
  await F(s, "grok.roomkey")(s, "default", { key: "Enter", shiftKey: true });
  assert.equal(calls.inserts.length, n, "Shift+Enter newlines, no send");
  await F(s, "grok.roomkey")(s, "default", { key: "Enter", shiftKey: false });
  assert.equal(calls.inserts.length, n + 1, "Enter sends");
  assert.equal(calls.inserts.at(-1).rows[0].body, "enter-sent");
});

// ── live twins (appkit's real local stack; skip when it's down) ──────────────
const APPKIT_URL = "http://127.0.0.1:54341";
const APPKIT_KEY = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
const stackUp = await fetch(`${APPKIT_URL}/auth/v1/health`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok).catch(() => false);

const bootLive = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["grok", "supabase", "supabase-auth", "session", "sheets"]);
  await resolveFn(s, "hydrate")(s, [], []);
  await precomputeOptional(s);
  await resolveFn(s, "runCycle")(s);
  await resolveFn(s, "setCel")(s, "sb.default", { celType: "ValueCel", v: { url: APPKIT_URL, anonkey: APPKIT_KEY }, metadata: { key: "sb.default", segment: "supabase", name: "default" } });
  return s;
};

test.skipIf(!stackUp)("LIVE: an anonymous rooms query leaks NO content (lounge shell at most)", async () => {
  const s = await bootLive();
  const rooms = await F(s, "grok.loadrooms")(s, "default");
  // appkit's list_conversations is SECURITY DEFINER: an anonymous caller gets
  // at most the public lounge SHELL — never member rooms, never message bodies.
  assert.ok(rooms.every((r) => r.kind === "lounge"), `only the lounge shell is visible anonymously: ${JSON.stringify(rooms)}`);
  assert.ok(rooms.every((r) => r.last_body === "" && r.unread === 0), "no message content leaks to an anonymous caller");
});

test.skipIf(!stackUp)("LIVE: signed-out room send is gated before any network write", async () => {
  const s = await bootLive();
  await resolveFn(s, "setValue")(s, "grok.room", LOUNGE);
  await F(s, "grok.field")(s, "grok.roomq", { target: { value: "should not land" } });
  await F(s, "grok.roomsend")(s, "default");
  assert.match(String(v(s, "grok.status")), /sign in first/);
});

afterAll(() => stub.stop());
