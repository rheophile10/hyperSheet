// collab.ts — the manual end-to-end collaboration harness. Runs BOTH the origin
// dev server (the app, on :5174) AND the WebRTC signaling relay (on :8787, the
// sheetsync.relay default) in one process, bound to all interfaces so a second
// device on your LAN can join too.
//
//   bun collab.ts            →  app  http://localhost:5174   relay  ws://localhost:8787
//
// Then collaborate:
//   1. Open the app in TWO SEPARATE browser profiles (or one normal + one
//      Incognito window, or two different machines). Two TABS in the SAME profile
//      share one OPFS origin = ONE identity, so they'd be the same user — use
//      separate profiles to get two distinct people.
//   2. In each: open the 👤 Profile app, set a passcode → you get a key identity.
//   3. In each: open the SAME sheet — e.g. the 📊 Sheet app → it makes "sheet1"
//      (both must use the same doc name; same name = same room).
//   4. In BOTH workbooks press 📡 (Go Live). They meet in room "plastron-sheet1".
//   5. In ONE, press 🤝 (Grant) to give the other write access + the sheet key.
//   6. Type in a cell and press ⚡ — the edit appears in the other browser, end to
//      end encrypted over the peer DataChannel. Edits flow both ways.
//
// The relay only brokers the WebRTC handshake; it NEVER sees sheet data (that
// rides the P2P channel, encrypted with the shared sheet key).
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { startSignalServer } from "../signal-server.ts";

const APP_PORT = Number(process.env.PORT ?? 5174);
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 8787);

const lanIp = (): string | null => {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  }
  return null;
};

// the signaling relay (in-process)
const relay = startSignalServer(RELAY_PORT);

// the app dev server (reuse serve.ts so app bundling/archive-baking stays in one place)
const here = new URL("./", import.meta.url).pathname;
const app = spawn("bun", [here + "serve.ts"], { stdio: "inherit", env: { ...process.env, PORT: String(APP_PORT) } });

const ip = lanIp();
const bar = "─".repeat(64);
console.log(`\n${bar}`);
console.log(`  plastron collab harness`);
console.log(`${bar}`);
console.log(`  app    http://localhost:${APP_PORT}` + (ip ? `   (LAN: http://${ip}:${APP_PORT})` : ""));
console.log(`  relay  ws://localhost:${RELAY_PORT}` + (ip ? `   (LAN: ws://${ip}:${RELAY_PORT})` : ""));
console.log(`${bar}`);
console.log(`  To collaborate (two DISTINCT identities needed):`);
console.log(`   1. Open the app in two separate browser profiles / Incognito`);
console.log(`      (two tabs in one profile share OPFS = the same identity).`);
console.log(`   2. Each: 👤 Profile → set a passcode (mints your key).`);
console.log(`   3. Each: 📊 Sheet → opens "sheet1" (same name = same room).`);
console.log(`   4. Both: press 📡 Go Live.   5. One: press 🤝 Grant.`);
console.log(`   6. Edit a cell + ⚡ — it appears in the other browser.`);
console.log(`${bar}\n`);

const shutdown = (): void => { try { relay.stop(); } catch { /* */ } try { app.kill(); } catch { /* */ } process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
app.on("exit", (code) => { try { relay.stop(); } catch { /* */ } process.exit(code ?? 0); });
