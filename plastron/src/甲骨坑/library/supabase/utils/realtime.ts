// ============================================================================
// supabase/realtime — the Phoenix-channel WebSocket client for Postgres changes.
// A persistent socket per project (module-scope, like peer's RTC transport);
// each subscribed table is a channel. On a `postgres_changes` push it calls the
// table's onChange (which bumps sb.<project>.<table>.rev) — so a server-side
// change re-fires a subscribed select formula through the SAME rev cel a local
// write bumps. No new reactivity machinery: realtime is just another bump source.
//
// Structurally narrowed (tsconfig lib is ES2023, no DOM): we describe only the
// WebSocket surface we touch, reading it off globalThis (Bun + browser).
// ============================================================================

interface WSLike {
  readyState: number; // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
  send(data: string): void;
  close(): void;
  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void;
}
type WSCtor = new (url: string) => WSLike;

interface Channel { table: string; schema: string; onChange: () => void }
interface Conn {
  ws: WSLike;
  ref: number;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  channels: Map<string, Channel>; // topic → channel
  ready: Promise<void>;
}

const conns = new Map<string, Conn>(); // project → connection

const wsUrlOf = (httpUrl: string): string =>
  httpUrl.replace(/\/+$/, "").replace(/^http/, "ws") + "/realtime/v1/websocket";

const nextRef = (c: Conn): string => String(++c.ref);

const ensureConn = (project: string, url: string, apikey: string): Conn | undefined => {
  const existing = conns.get(project);
  if (existing && existing.ws.readyState <= 1) return existing; // CONNECTING or OPEN

  const WS = (globalThis as { WebSocket?: WSCtor }).WebSocket;
  if (!WS) return undefined;

  const ws = new WS(`${wsUrlOf(url)}?apikey=${encodeURIComponent(apikey)}&vsn=1.0.0`);
  const conn: Conn = { ws, ref: 0, heartbeat: undefined, channels: new Map(), ready: Promise.resolve() };

  conn.ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("realtime: socket open timed out")), 5000);
    (timer as { unref?: () => void })?.unref?.();
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      conn.heartbeat = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: nextRef(conn) }));
      }, 25000);
      (conn.heartbeat as { unref?: () => void })?.unref?.();
      resolve();
    });
  });

  ws.addEventListener("message", (ev) => {
    let msg: { event?: string; topic?: string };
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg.event === "postgres_changes" && msg.topic) {
      conn.channels.get(msg.topic)?.onChange();
    }
  });
  ws.addEventListener("close", () => {
    if (conn.heartbeat) clearInterval(conn.heartbeat);
    conns.delete(project);
  });
  ws.addEventListener("error", () => { /* close fires next; nothing to do */ });

  conns.set(project, conn);
  return conn;
};

export interface SubscribeOpts {
  url: string; apikey: string; token?: string;
  project: string; schema: string; table: string;
  onChange: () => void;
}

const topicOf = (project: string, schema: string, table: string): string => `realtime:${project}:${schema}:${table}`;

export const subscribe = async (opts: SubscribeOpts): Promise<string> => {
  const { url, apikey, token, project, schema, table, onChange } = opts;
  const conn = ensureConn(project, url, apikey);
  if (!conn) return "(realtime: no WebSocket in this host)";
  try { await conn.ready; } catch (e) { return `(realtime: ${(e as Error).message})`; }

  const topic = topicOf(project, schema, table);
  if (conn.channels.has(topic)) return `realtime: already subscribed to ${schema}.${table}`;
  conn.channels.set(topic, { table, schema, onChange });

  const ref = nextRef(conn);
  conn.ws.send(JSON.stringify({
    topic, event: "phx_join", ref, join_ref: ref,
    payload: {
      config: { postgres_changes: [{ event: "*", schema, table }], private: false },
      ...(token ? { access_token: token } : {}),
    },
  }));
  return `realtime: subscribed to ${schema}.${table}`;
};

export const unsubscribe = (project: string, schema: string, table: string): string => {
  const conn = conns.get(project);
  if (!conn) return "realtime: not connected";
  const topic = topicOf(project, schema, table);
  if (!conn.channels.delete(topic)) return `realtime: not subscribed to ${schema}.${table}`;
  try { conn.ws.send(JSON.stringify({ topic, event: "phx_leave", ref: nextRef(conn), payload: {} })); } catch { /* socket gone */ }
  if (conn.channels.size === 0) { try { conn.ws.close(); } catch { /* already closed */ } conns.delete(project); }
  return `realtime: unsubscribed from ${schema}.${table}`;
};

export const realtimeStatus = (project: string): { connected: boolean; channels: string[] } => {
  const conn = conns.get(project);
  return {
    connected: !!conn && conn.ws.readyState === 1,
    channels: conn ? [...conn.channels.values()].map((c) => `${c.schema}.${c.table}`) : [],
  };
};
