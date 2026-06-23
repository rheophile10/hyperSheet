// wasi-host — a GENERIC WASI snapshot_preview1 host for any wasi-libc wasm app
// (windowing-architecture.md / the doom-harness generalization). This is the
// reusable half of a wasm app's harness: the WASI imports + memory/stdio helpers +
// a virtual READ-ONLY file table (a preopened "/" serving { basename → bytes }).
// An ENGINE (doom, …) composes this with its own `env.*` imports (its ABI) + a
// render loop; only those engine bits are app-specific. Extracted from doom-harness
// so the WASI bulk is shared across wasm apps (other games, Rust/C/Zig tools, …).
//
// Pure over an injected memory: call setInstance(inst) after WebAssembly.instantiate
// (or pass a fake { exports: { memory } } in tests). All file IO is the file table —
// path mutation is ENOSYS, save/config opens are ENOENT (apps fall back to defaults).

interface WasmMemory { buffer: ArrayBuffer }
export interface WasiInstance { exports: { memory: WasmMemory } & Record<string, unknown> }
export interface WasiHostOptions {
  /** Read-only files served via the preopened "/". Keyed by the BASENAME the wasm
   *  asks for (path_open matches on basename). e.g. { "freedoom1.wad": bytes }. */
  files?: Record<string, Uint8Array>;
  onLog?: (line: string) => void;
  onExit?: (code: number) => void;
}
export interface WasiHost {
  /** The wasi_snapshot_preview1 import table — spread into your imports envelope. */
  wasi: Record<string, (...args: unknown[]) => unknown>;
  /** Capture the instance after instantiate (memory is read live to survive grow). */
  setInstance: (inst: WasiInstance) => void;
  mem: () => { u8: Uint8Array; view: DataView };
}

const E_SUCCESS = 0, E_BADF = 8, E_INVAL = 28, E_NOENT = 44, E_NOSYS = 52;
const FILETYPE_DIRECTORY = 3, FILETYPE_REGULAR_FILE = 4, PREOPENTYPE_DIR = 0;
const FD_STDIN = 0, FD_STDOUT = 1, FD_STDERR = 2, FD_PREOPEN_ROOT = 3;

const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p;

export function createWasiHost(opts: WasiHostOptions = {}): WasiHost {
  const { onLog = () => {}, onExit = () => {} } = opts;
  const files = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(opts.files ?? {})) files.set(basename(k).toLowerCase(), v);

  let instance: WasiInstance | null = null;
  const open = new Map<number, { bytes: Uint8Array; cursor: number }>();   // fd → cursored read
  let nextFd = FD_PREOPEN_ROOT + 1;
  const stdioBuf: [string, string] = ["", ""];

  const setInstance = (inst: WasiInstance): void => { instance = inst; };
  const mem = () => { const buf = instance!.exports.memory.buffer; return { u8: new Uint8Array(buf), view: new DataView(buf) }; };
  const td = new TextDecoder();
  const emit = (which: 0 | 1, chunk: string): void => {
    const parts = (stdioBuf[which] + chunk).split("\n");
    stdioBuf[which] = parts.pop() ?? "";
    for (const line of parts) onLog(line);
  };
  const statFile = (buf: number, filetype: number): number => {
    const m = mem();
    m.view.setUint8(buf, filetype); m.view.setUint16(buf + 2, 0, true);
    m.view.setBigUint64(buf + 8, 0xffffffffffffffffn, true);
    m.view.setBigUint64(buf + 16, 0xffffffffffffffffn, true);
    return E_SUCCESS;
  };

  const fd_close = (fd: number): number => { open.delete(fd); return E_SUCCESS; };
  const fd_fdstat_get = (fd: number, buf: number): number =>
    (fd === FD_PREOPEN_ROOT) ? statFile(buf, FILETYPE_DIRECTORY)
    : (fd <= FD_STDERR || open.has(fd)) ? statFile(buf, FILETYPE_REGULAR_FILE) : E_BADF;
  const fd_fdstat_set_flags = (): number => E_SUCCESS;
  const fd_prestat_get = (fd: number, buf: number): number => {
    if (fd !== FD_PREOPEN_ROOT) return E_BADF;                 // libc enumerates from 3; BADF ends the scan
    const m = mem(); m.view.setUint8(buf, PREOPENTYPE_DIR); m.view.setUint32(buf + 4, 1, true); return E_SUCCESS;
  };
  const fd_prestat_dir_name = (fd: number, ptr: number, len: number): number => {
    if (fd !== FD_PREOPEN_ROOT) return E_BADF; if (len < 1) return E_INVAL;
    mem().u8[ptr] = 0x2f; return E_SUCCESS;                    // "/"
  };
  const fd_read = (fd: number, iovs: number, iovsLen: number, nread: number): number => {
    const m = mem();
    if (fd === FD_STDIN) { m.view.setUint32(nread, 0, true); return E_SUCCESS; }
    const f = open.get(fd); if (!f) return E_BADF;
    let total = 0;
    for (let i = 0; i < iovsLen; i++) {
      const ent = iovs + i * 8, buf = m.view.getUint32(ent, true), len = m.view.getUint32(ent + 4, true);
      const n = Math.min(len, Math.max(0, f.bytes.length - f.cursor));
      if (n > 0) { m.u8.set(f.bytes.subarray(f.cursor, f.cursor + n), buf); f.cursor += n; total += n; }
      if (n < len) break;                                      // EOF in this iov
    }
    m.view.setUint32(nread, total, true); return E_SUCCESS;
  };
  const fd_seek = (fd: number, offset: bigint, whence: number, newoff: number): number => {
    const f = open.get(fd); if (!f) return E_BADF;
    const off = Number(offset);
    const next = whence === 0 ? off : whence === 1 ? f.cursor + off : whence === 2 ? f.bytes.length + off : -1;
    if (next < 0) return E_INVAL;
    f.cursor = next; mem().view.setBigUint64(newoff, BigInt(next), true); return E_SUCCESS;
  };
  const fd_write = (fd: number, iovs: number, iovsLen: number, nwritten: number): number => {
    const m = mem(); let total = 0, str = "";
    for (let i = 0; i < iovsLen; i++) {
      const ent = iovs + i * 8, buf = m.view.getUint32(ent, true), len = m.view.getUint32(ent + 4, true);
      if (fd === FD_STDOUT || fd === FD_STDERR) str += td.decode(m.u8.subarray(buf, buf + len));
      total += len;
    }
    m.view.setUint32(nwritten, total, true);
    if (str) emit(fd === FD_STDOUT ? 0 : 1, str);
    return E_SUCCESS;
  };
  const path_open = (_dirfd: number, _df: number, ptr: number, len: number, _of: number, _rb: bigint, _ri: bigint, _ff: number, fdOut: number): number => {
    const m = mem();
    const name = basename(td.decode(m.u8.subarray(ptr, ptr + len))).toLowerCase();
    const bytes = files.get(name);
    if (!bytes) return E_NOENT;                                // not in the table → app keeps scanning / uses defaults
    const fd = nextFd++; open.set(fd, { bytes, cursor: 0 });
    m.view.setUint32(fdOut, fd, true); return E_SUCCESS;
  };
  const noMutation = (): number => E_NOSYS;                    // path_create_directory/remove/rename/unlink
  const proc_exit = (code: number): never => { onExit(code); throw new Error(`proc_exit(${code})`); };

  // ── common stubs other wasi-libc modules expect (doom doesn't, but harmless) ──
  const args_sizes_get = (argc: number, bufLen: number): number => { const m = mem(); m.view.setUint32(argc, 0, true); m.view.setUint32(bufLen, 0, true); return E_SUCCESS; };
  const environ_sizes_get = args_sizes_get;
  const emptyOk = (): number => E_SUCCESS;                     // args_get / environ_get write nothing
  const clock_time_get = (_id: number, _prec: bigint, out: number): number => {
    mem().view.setBigUint64(out, BigInt(Math.floor((globalThis as { performance?: { now(): number } }).performance?.now?.() ?? 0) * 1e6), true);
    return E_SUCCESS;
  };
  const clock_res_get = (_id: number, out: number): number => { mem().view.setBigUint64(out, 1000n, true); return E_SUCCESS; };
  const random_get = (ptr: number, len: number): number => {
    const m = mem(); const slice = m.u8.subarray(ptr, ptr + len);
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
    if (c?.getRandomValues) c.getRandomValues(slice); else for (let i = 0; i < len; i++) slice[i] = 0;
    return E_SUCCESS;
  };
  const poll_oneoff = (): number => E_NOSYS;
  const sched_yield = (): number => E_SUCCESS;

  return {
    setInstance, mem,
    wasi: {
      fd_close, fd_fdstat_get, fd_fdstat_set_flags, fd_prestat_get, fd_prestat_dir_name,
      fd_read, fd_seek, fd_write,
      path_open,
      path_create_directory: noMutation, path_remove_directory: noMutation, path_rename: noMutation, path_unlink_file: noMutation,
      proc_exit,
      args_sizes_get, args_get: emptyOk, environ_sizes_get, environ_get: emptyOk,
      clock_time_get, clock_res_get, random_get, poll_oneoff, sched_yield,
    } as Record<string, (...args: unknown[]) => unknown>,
  };
}
