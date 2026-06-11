import { test } from "bun:test";
import assert from "node:assert/strict";
import { startSignalServer } from "./signal-server.ts";

// The relay brokers offer/answer between peers in a room (never sees sheet data).
test("signal-server: room join notifies existing members + relays messages", async () => {
  const { stop, port } = startSignalServer(0); // ephemeral port
  const url = `ws://localhost:${port}`;
  const open = (ws: WebSocket) => new Promise<void>((r) => (ws.onopen = () => r()));
  const next = (ws: WebSocket) => new Promise<any>((r) => (ws.onmessage = (e) => r(JSON.parse(String(e.data)))));

  const A = new WebSocket(url); await open(A);
  A.send(JSON.stringify({ t: "join", room: "r1" }));
  assert.deepEqual(await next(A), { t: "joined", n: 1 }, "A joins, alone");

  const aGetsPeerJoined = next(A);                 // A should be told when B arrives
  const B = new WebSocket(url); await open(B);
  B.send(JSON.stringify({ t: "join", room: "r1" }));
  assert.deepEqual(await next(B), { t: "joined", n: 2 }, "B joins, room has 2");
  assert.deepEqual(await aGetsPeerJoined, { t: "peer-joined" }, "A notified a peer joined");

  // A relays an offer → B receives it verbatim
  const bGetsOffer = next(B);
  A.send(JSON.stringify({ t: "offer", sdp: "SDP-A" }));
  assert.deepEqual(await bGetsOffer, { t: "offer", sdp: "SDP-A" }, "offer relayed A→B");

  // a peer in a DIFFERENT room is isolated
  const C = new WebSocket(url); await open(C);
  C.send(JSON.stringify({ t: "join", room: "other" }));
  await next(C);
  let cGotLeak = false; C.onmessage = () => (cGotLeak = true);
  B.send(JSON.stringify({ t: "answer", sdp: "SDP-B" }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(cGotLeak, false, "rooms are isolated");

  A.close(); B.close(); C.close(); stop();
});
