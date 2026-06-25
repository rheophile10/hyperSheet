// signal-server — a tiny room-based WebRTC signaling relay for plastron peers.
// It brokers offer/answer between peers in the same room and NEVER sees sheet
// data (that rides the P2P DataChannel). Run: `bun signal-server.ts [port]`.
//
// Protocol (JSON over WS):
//   client → {t:"join", room}        server → {t:"joined", n}     (n = members incl. you)
//   server → {t:"peer-joined"}       (to existing members when a newcomer arrives)
//   any other message is RELAYED verbatim to the other members of the room
//   (offer/answer carry non-trickle SDP, so no separate ICE relay is needed).

interface WSData { room?: string; id?: string }
type Sock = { send: (m: string) => void; data: WSData };

export const startSignalServer = (port = 8787): { stop: () => void; port: number } => {
  const rooms = new Map<string, Set<Sock>>();
  const server = (globalThis as { Bun?: { serve: (o: unknown) => { stop: () => void; port: number } } }).Bun!.serve({
    port,
    fetch(req: Request, srv: { upgrade: (r: Request, o?: unknown) => boolean }) {
      if (srv.upgrade(req, { data: {} as WSData })) return undefined;
      return new Response("plastron signal-server");
    },
    websocket: {
      message(ws: Sock, raw: string) {
        let m: { t?: string; room?: string; id?: string };
        try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.t === "join" && typeof m.room === "string") {
          const set = rooms.get(m.room) ?? rooms.set(m.room, new Set()).get(m.room)!;
          ws.data.id = typeof m.id === "string" ? m.id : undefined;
          for (const peer of set) peer.send(JSON.stringify({ t: "peer-joined", id: ws.data.id }));  // tell existing members the newcomer's id → each offers to it (full mesh)
          set.add(ws); ws.data.room = m.room;
          ws.send(JSON.stringify({ t: "joined", n: set.size }));
          return;
        }
        // relay everything else to the OTHER members of the room
        const set = ws.data.room ? rooms.get(ws.data.room) : undefined;
        if (set) for (const peer of set) if (peer !== ws) peer.send(String(raw));
      },
      close(ws: Sock) { if (ws.data?.room) rooms.get(ws.data.room)?.delete(ws); },
    },
  });
  return { stop: () => server.stop(), port: server.port };
};

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 8787);
  const { port: p } = startSignalServer(port);
  console.log(`plastron signal-server on ws://localhost:${p}`);
}
