import type { 甲骨, Cel, Compiler, Fn } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// php-compiler — kind "php": a PHP source file (defining named functions) →
// a callable Fn via php-wasm. The `:= php.<fn>{ … }` selector picks the
// trailing function name (PHP has no "last expression IS the callable" form,
// so the name is required and stored as the f's trailing line per the
// lang-module convention).
//
// php-wasm runs a PERSISTENT interpreter, so re-running a file that redefines
// functions throws "Cannot redeclare". Each compile therefore defines its
// source in a FRESH namespace (`PL_<n>`); a recompile lands in a new namespace
// and never collides — which is exactly what `:=` redefinition needs. Calls
// marshal args/return as JSON (base64 to sidestep quoting).
//
// The runtime call is ASYNC (php-wasm has no sync path), so the compiled Fn
// returns a Promise. fireCel awaits a Promise cel value (runCycle.ts), so a
// php verb works as a WHOLE-formula value (`=lib.GREET(41)`); it can't be
// nested inside synchronous arithmetic in the same formula.
// ============================================================================

interface PhpLike {
  binary: Promise<unknown>;
  addEventListener(type: string, cb: (e: { detail?: unknown[] }) => void): void;
  run(code: string): Promise<unknown>;
}

let _php: Promise<PhpLike> | undefined;
let _buf = "";
let _gen = 0;

const getPhp = (): Promise<PhpLike> => {
  if (!_php) {
    _php = (async (): Promise<PhpLike> => {
      const isBrowser = typeof (globalThis as { window?: unknown }).window !== "undefined";
      const spec = isBrowser ? "php-wasm/PhpWeb.mjs" : "php-wasm/PhpNode.mjs";
      const mod = (await import(spec)) as Record<string, new () => PhpLike>;
      const Php = isBrowser ? mod.PhpWeb : mod.PhpNode;
      const php = new Php();
      php.addEventListener("output", (e) => { _buf += ((e.detail ?? []) as unknown[]).join(""); });
      await php.binary;
      return php;
    })();
  }
  return _php;
};

const runPhp = async (code: string): Promise<string> => {
  const php = await getPhp();
  _buf = "";
  await php.run(code);
  return _buf;
};

const toB64 = (s: string): string =>
  typeof Buffer !== "undefined"
    ? Buffer.from(s, "utf8").toString("base64")
    : btoa(unescape(encodeURIComponent(s)));

// f = "<source>\n<funcName>" — the trailing line names the callable.
const splitTrailing = (src: string): { body: string; fn: string } => {
  const i = src.lastIndexOf("\n");
  if (i < 0) return { body: "", fn: src.trim() };
  return { body: src.slice(0, i), fn: src.slice(i + 1).trim() };
};

const phpCompiler: Compiler = (async (source: string): Promise<Fn> => {
  const { body, fn } = splitTrailing(String(source ?? ""));
  if (!/^[A-Za-z_]\w*$/.test(fn)) {
    throw new Error("php-compiler: a trailing function name is required — use `seg.fn := php.<name>{ … }`.");
  }
  const ns = `PL_${_gen++}`;
  await runPhp(`<?php\nnamespace ${ns};\n${body}`); // define once, isolated
  const target = `${ns}\\${fn}`;
  return (async (...args: unknown[]): Promise<unknown> => {
    const b64 = toB64(JSON.stringify(args));
    const out = await runPhp(
      `<?php echo json_encode(call_user_func_array('${target}', json_decode(base64_decode('${b64}'), true)));`,
    );
    return out === "" ? null : JSON.parse(out);
  }) as Fn;
}) as Compiler;

export const name = "php-compiler" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["php", phpCompiler as Fn],
]));
