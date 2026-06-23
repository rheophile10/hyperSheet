import { test } from "bun:test";
import assert from "node:assert/strict";
import { createWasiHost } from "../dist/甲骨坑/library/winapps-wasm/index.js";

// createWasiHost — the generic WASI host extracted from doom-harness. Driven here
// with a MOCK memory the way wasi-libc would call it: preopen scan, path_open on the
// virtual file table, fd_read/seek/close, stdout buffering, proc_exit, and the common
// stubs. No real wasm needed — it's pure over the injected memory.

const setup = (files, opts = {}) => {
  const log = [];
  const exits = [];
  const host = createWasiHost({ files, onLog: (l) => log.push(l), onExit: (c) => exits.push(c), ...opts });
  const buffer = new ArrayBuffer(65536);
  const u8 = new Uint8Array(buffer), view = new DataView(buffer);
  host.setInstance({ exports: { memory: { buffer } } });
  const writeStr = (off, s) => { const b = new TextEncoder().encode(s); u8.set(b, off); return b.length; };
  return { host, u8, view, writeStr, log, exits };
};

const WAD = new Uint8Array([0x49, 0x57, 0x41, 0x44, 1, 2, 3, 4]); // "IWAD" + 4 bytes

test("preopen scan: fd 3 is the root dir, fd 4 ends the scan", () => {
  const { host, view } = setup({ "doom1.wad": WAD });
  assert.equal(host.wasi.fd_prestat_get(3, 0), 0, "fd 3 (preopen root) ok");
  assert.equal(view.getUint32(4, true), 1, "name length 1 (\"/\")");
  assert.equal(host.wasi.fd_prestat_dir_name(3, 100, 1), 0);
  assert.equal(host.wasi.fd_prestat_get(4, 0), 8 /* EBADF */, "fd 4 BADF ends the libc preopen scan");
});

test("path_open serves a file by basename (case-insensitive); reads + seeks it; missing → ENOENT", () => {
  const { host, u8, view, writeStr } = setup({ "doom1.wad": WAD });

  // doom probes many IWAD names; only the one in the table opens.
  const plen = writeStr(100, "/DOOM1.WAD");
  assert.equal(host.wasi.path_open(3, 0, 100, plen, 0, 0n, 0n, 0, 0), 0, "the WAD opens");
  const fd = view.getUint32(0, true);
  assert.ok(fd >= 4, "got a real fd");

  // a missing name → ENOENT (so the app keeps scanning / uses defaults)
  const mlen = writeStr(200, "doom2.wad");
  assert.equal(host.wasi.path_open(3, 0, 200, mlen, 0, 0n, 0n, 0, 4), 44 /* ENOENT */, "missing file → ENOENT");

  // fd_read: one iovec {buf@300, len 4}
  view.setUint32(8, 300, true); view.setUint32(12, 4, true);
  assert.equal(host.wasi.fd_read(fd, 8, 1, 16), 0);
  assert.equal(view.getUint32(16, true), 4, "read 4 bytes");
  assert.deepEqual([...u8.subarray(300, 304)], [0x49, 0x57, 0x41, 0x44], "got the file's first 4 bytes");

  // fd_seek back to 0, read again → same bytes
  assert.equal(host.wasi.fd_seek(fd, 0n, 0 /* SET */, 24), 0);
  assert.equal(Number(view.getBigUint64(24, true)), 0, "cursor rewound");
  view.setUint32(8, 320, true); view.setUint32(12, 2, true);
  host.wasi.fd_read(fd, 8, 1, 16);
  assert.deepEqual([...u8.subarray(320, 322)], [0x49, 0x57], "re-read from the start");

  assert.equal(host.wasi.fd_close(fd), 0, "close ok");
  assert.equal(host.wasi.fd_read(fd, 8, 1, 16), 8 /* EBADF */, "reading a closed fd → BADF");
});

test("fd_write to stdout buffers and flushes whole lines to onLog", () => {
  const { host, view, writeStr, log } = setup({});
  const n = writeStr(400, "hello\nwor");
  view.setUint32(8, 400, true); view.setUint32(12, n, true);
  host.wasi.fd_write(1 /* stdout */, 8, 1, 16);
  assert.deepEqual(log, ["hello"], "complete line flushed; partial 'wor' buffered");
  const n2 = writeStr(420, "ld\n");
  view.setUint32(8, 420, true); view.setUint32(12, n2, true);
  host.wasi.fd_write(1, 8, 1, 16);
  assert.deepEqual(log, ["hello", "world"], "buffered partial completed");
});

test("proc_exit throws and reports the code; common stubs answer", () => {
  const { host, view, exits } = setup({});
  assert.throws(() => host.wasi.proc_exit(0), /proc_exit\(0\)/);
  assert.deepEqual(exits, [0], "onExit got the code");

  host.wasi.args_sizes_get(0, 4);
  assert.equal(view.getUint32(0, true), 0, "argc 0");
  assert.equal(host.wasi.random_get(500, 16), 0, "random_get ok");
  assert.equal(host.wasi.clock_time_get(0, 0n, 8), 0, "clock_time_get ok");
});
