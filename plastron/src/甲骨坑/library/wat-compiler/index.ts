import type { 甲骨, Cel, CompileContext, CompiledEnvelope, Compiler, Fn, State } from "../../../types/index.js";
import { resolveFn, bindNativeFns } from "../../../kernel/index.js";
import { CSP_WASM_AVAILABLE_KEY } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// host capability namespace, read through the cel registry (isolation:
// the host segment owns the fn; we own only the key).
const readHostImports = (st: State): Record<string, Fn> =>
  ((resolveFn(st, "host.imports") as Fn | undefined)?.(st) ?? {}) as Record<string, Fn>;

// wat-compiler — the "wat" LockedLambdaCel whose _fn is the WebAssembly
// text-format compiler. Other cels reference it as
//   LambdaCel.metadata.kind = "wat"
//
// Source flow: WAT text → wabt.js `parseWat` → wasm bytes →
// `WebAssembly.instantiate` → exported function as Fn. The wabt module
// is dynamic-imported on first compile (~600KB); apps that don't use
// WAT pay nothing.
//
// v1 (this file): main-thread, JS-canonical. The returned Fn takes JS
// numbers/typed-arrays and returns whatever the wasm export returns
// (i32/f64 unwrap to JS number, i64 to BigInt). No memory marshalling
// for strings/objects — authors using strings hand-roll their own
// ptr+length convention.
//
// Which export to call: an explicit `metadata.wasmExport` wins; else
// prefer `main`; else the single function export; multiple unnamed
// exports throw.
//
// Host access to the live instance (parity with `wasm-bytes`, proven in
// wasm-host-instance.test.mjs): imports default to `{ host }`; a
// `metadata.imports` provider cel returns either a bare imports object
// (namespaces → fns) OR an envelope `{ imports, onInstantiate?, dispose? }`.
// After `WebAssembly.instantiate`, `onInstantiate(instance, state)` fires
// once — handing the provider the live instance (every export + linear
// memory). This is what lets a shared-memory WAT module authored as
// LEGIBLE WAT TEXT on the sheet (kind:"wat", imports:"<provider>") expose
// its `memory` and drive multiple exports over its lifetime, closing the
// gap the wat compiler previously had (it wrapped one export and discarded
// the instance). `dispose` rides to `cel._dispose`. Backward compatible:
// a module naming no imports/wasmExport behaves exactly as before.
//
// CSP gate: when invoked with state, checks `csp.wasm-available`. The
// install itself never fails — the throw fires only when a WAT lambda
// actually tries to compile.

// wabt's types — kept structural so verbatimModuleSyntax + the CJS
// package's `export = wabt` shape don't fight each other. We import
// dynamically; this type matches what wabt 1.0.39 exposes.
interface WabtModule {
  parseWat: (filename: string, buffer: string | Uint8Array, options?: Record<string, boolean>) => WabtModuleHandle;
  readWasm: (buffer: Uint8Array, options?: Record<string, boolean>) => WabtModuleHandle;
}
interface WabtModuleHandle {
  toBinary: (options: Record<string, boolean>) => { buffer: Uint8Array; log: string };
  toText:   (options: Record<string, boolean>) => string;
  destroy:  () => void;
}

// Lazy-init wabt. Module-level singleton because the wabt instance is
// stateless and reusing it avoids re-instantiating the parser wasm on
// every compile. The bare import serves dev/CLI/tests (bundled or
// node_modules); the single-file dist marks wabt EXTERNAL (bundle.ts), so
// in the deployed browser the bare specifier rejects and we fall back to
// the CDN ESM build — same pattern as py-compiler's PYODIDE_CDN and
// plastron-gpu's three fallback. Overridable via globalThis.__wabtCdn.
const WABT_CDN = "https://cdn.jsdelivr.net/npm/wabt@1.0.37/+esm";
let _wabt: Promise<WabtModule> | undefined;
const getWabt = (): Promise<WabtModule> => {
  if (!_wabt) {
    _wabt = import("wabt")
      .catch(() => {
        const url = (globalThis as { __wabtCdn?: string }).__wabtCdn ?? WABT_CDN;
        return import(url) as Promise<{ default: unknown }>;
      })
      .then((m) => (m.default as () => Promise<WabtModule>)());
  }
  return _wabt;
};

// WebAssembly isn't in tsconfig "lib": ["ES2023"]. Reach through
// globalThis with a structural type so this works in both Node and
// browsers without pulling DOM types in. csp.ts does the same.
type WasmInstance = { exports: Record<string, unknown> };
type WasmInstantiateResult = { instance: WasmInstance };
type WasmGlobal = {
  instantiate?: (bytes: Uint8Array, imports: Record<string, unknown>) => Promise<WasmInstantiateResult>;
};
const _wasm = (globalThis as { WebAssembly?: WasmGlobal }).WebAssembly;

// A provider may return a bare imports object (namespaces → fns) OR an
// envelope that also carries host-instance hooks. Mirror of wasm-bytes.
interface ImportsEnvelope {
  imports: Record<string, unknown>;
  onInstantiate?: (instance: WasmInstance, state: State) => void;
  dispose?: () => void;
}
type ProviderResult = Record<string, unknown> | ImportsEnvelope;

// Envelope iff it has an own `imports` object property (the one ambiguous
// case — a module importing from a namespace literally named "imports" —
// is a documented reserved namespace, same as wasm-bytes).
const isImportsEnvelope = (r: ProviderResult): r is ImportsEnvelope => {
  const o = r as { imports?: unknown };
  return o !== null && typeof o === "object" &&
    typeof o.imports === "object" && o.imports !== null;
};

interface ResolvedImports {
  imports: Record<string, unknown>;
  onInstantiate?: (instance: WasmInstance, state: State) => void;
  dispose?: () => void;
}

// Imports: default { host } (modules that import nothing ignore it;
// WebAssembly only rejects *missing* declared imports, not extra ones). A
// metadata.imports provider cel returns either a bare imports object whose
// namespaces merge over the default, or an envelope whose .imports merge
// and whose hooks the compiler honors.
const resolveImports = (state: State | undefined, context?: CompileContext): ResolvedImports => {
  const base: Record<string, unknown> = { host: state ? readHostImports(state) : {} };
  if (!state || !context?.imports) return { imports: base };
  const providerCel = state.cels.get(context.imports) as { _fn?: Fn } | undefined;
  const provider = providerCel?._fn;
  if (!provider) {
    throw new Error(
      `wat-compiler: imports provider cel "${context.imports}" is not registered or has no fn.`,
    );
  }
  const result = provider(state) as ProviderResult;
  if (isImportsEnvelope(result)) {
    return {
      imports: { ...base, ...result.imports },
      onInstantiate: result.onInstantiate,
      dispose: result.dispose,
    };
  }
  return { imports: { ...base, ...result } };
};

const watCompiler: Compiler = (async (
  source: string, state?: State, context?: CompileContext,
): Promise<CompiledEnvelope> => {
  if (state) {
    const wasmAvailable =
      state.cels.get(CSP_WASM_AVAILABLE_KEY)?.v as boolean | undefined;
    if (wasmAvailable === false) {
      throw new Error(
        `wat-compiler: WebAssembly is unavailable in this environment ` +
        `(csp.wasm-available = false). This app cannot compile WAT lambdas.`,
      );
    }
  }
  if (!_wasm?.instantiate) {
    throw new Error(`wat-compiler: WebAssembly.instantiate is not available in this runtime.`);
  }

  // 1. WAT text → wasm bytes via wabt.
  const wabt = await getWabt();
  const mod = wabt.parseWat("inline.wat", source, {
    multi_value: true,
    bulk_memory: true,
    sign_extension: true,
    sat_float_to_int: true,
  });
  let bytes: Uint8Array;
  try {
    bytes = mod.toBinary({}).buffer;
  } finally {
    mod.destroy();
  }

  // 2. Bytes → instance, against the resolved imports (default { host },
  //    plus any metadata.imports provider's namespaces). Then hand the
  //    live instance to the provider's onInstantiate hook (if any), so a
  //    host segment can drive a multi-export / shared-memory module. The
  //    "host" namespace serves modules that (import "host" "log" ...) etc.
  const { imports, onInstantiate, dispose } = resolveImports(state, context);
  const { instance } = await _wasm.instantiate(bytes, imports);
  if (onInstantiate && state) onInstantiate(instance, state);

  // 3. Pick the export. Explicit wasmExport wins; else prefer `main`;
  //    else the single function export; else throw — ambiguous.
  const fnExports = Object.entries(instance.exports)
    .filter(([, v]) => typeof v === "function") as [string, Fn][];
  if (fnExports.length === 0) {
    throw new Error(`wat-compiler: module has no function exports.`);
  }
  const want = context?.wasmExport;
  let fn: Fn | null;
  if (want) {
    const hit = fnExports.find(([k]) => k === want);
    if (!hit) {
      const names = fnExports.map(([k]) => k).join(", ");
      throw new Error(
        `wat-compiler: module has no function export named "${want}" (exports: ${names}).`,
      );
    }
    fn = hit[1];
  } else {
    const main = fnExports.find(([k]) => k === "main");
    fn = main ? main[1] : fnExports.length === 1 ? fnExports[0]![1] : null;
    if (!fn) {
      const names = fnExports.map(([k]) => k).join(", ");
      throw new Error(
        `wat-compiler: module exports multiple functions (${names}); ` +
        `set metadata.wasmExport to choose one, name one "main", or restrict ` +
        `the module to a single export.`,
      );
    }
  }
  // Return a CompiledEnvelope so hydrate stashes the wasm bytes on
  // cel._wasm (read by wasm-to-wat for the "Show WAT" diagnostic and by
  // future worker dispatch). A provider-supplied dispose rides to
  // cel._dispose for teardown.
  const envelope: CompiledEnvelope = { fn, wasm: bytes };
  if (dispose) envelope.dispose = dispose;
  return envelope;
}) as Compiler;

// wasm-to-wat — render any wasm module's bytes as its WAT text form.
// Useful for inspecting wat cels' compiled output (round-trip canonical
// form) and, more interestingly, for inspecting Rust / other-language
// wasm produced by other kinds. Apps build whatever UI they want on
// top; the cel just returns the text.
const wasmToWat: Fn = async (bytes: unknown): Promise<string> => {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(
      `wasm-to-wat: expected Uint8Array of wasm bytes, got ${typeof bytes}.`,
    );
  }
  const wabt = await getWabt();
  const mod = wabt.readWasm(bytes, { readDebugNames: true });
  try {
    // foldExprs gives a readable nested layout; inlineExport keeps the
    // (export "main" ...) inline with the func — both are the defaults
    // wabt's own wasm2wat CLI uses.
    return mod.toText({ foldExprs: true, inlineExport: true });
  } finally {
    mod.destroy();
  }
};

// Bridge fns — v1 identity. Scalars (i32/u32/f32/f64) survive a JS
// round trip cleanly without marshalling; WebAssembly's number type
// coercion makes JS numbers acceptable to wasm imports directly. For
// composite types and worker-based wat instances, both bridges become
// real marshalling calls into the kind worker's toJs/fromJs protocol.
// The function shape stays the same so call sites (formulas using
// `(wat-to-js x)` or `(js-to-wat x)`) don't change as composites land.
const watToJs:  Fn = (v: unknown) => v;
const jsToWat:  Fn = (v: unknown) => v;

export const name = "wat-compiler" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["wat",         watCompiler as Fn],
  ["wat-to-js",   watToJs],
  ["js-to-wat",   jsToWat],
  ["wasm-to-wat", wasmToWat],
]));
