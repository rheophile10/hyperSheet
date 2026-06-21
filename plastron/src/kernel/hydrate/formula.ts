import type {
  CompileCelBodyOpts, CompileContext, CompiledLambda, Compiler, FireableCel, Key, Schema,
  State, WitType,
} from "../../types/index.js";
import { resolveFn } from "../resolve-fn.js";
import { appendError, makeCelError } from "../cel-error.js";
import { isConsented } from "../segments/consent.js";
/** Reserved cel key: locked ValueCel whose v is the compile cache —
 *  Map<`${kindKey}:${source}${ctx}`, Promise<CompiledLambda>>. */
export const COMPILE_CACHE_KEY = "compile.cache" as const;

// Resolve a cel's metadata.outputSchema → WitType, when the schema is
// wasm-kind. Returns undefined for missing schema, non-wasm schema
// (Zod), or a wasm-kind schema with no wit type set. Compilers that
// honor composite WIT output schemas (py-compiler, future js/wat)
// read this through CompileContext to decide handle-vs-marshal.
const resolveOutputWitType = (cel: FireableCel, state: State): WitType | undefined => {
  const md = cel.metadata as { outputSchema?: Key };
  const schemaKey = md.outputSchema;
  if (!schemaKey) return undefined;
  const schemaCel = state.cels.get(schemaKey);
  if (!schemaCel) return undefined;
  const schema = schemaCel.v as Schema | undefined;
  if (!schema || schema.kind !== "wasm" || !schema.wit) return undefined;
  return schema.wit;
};

// Formula hydration — compile a fireable cel's source body (cel.f)
// into the runtime closure stored on cel._fn / cel._buildEvaluate.
//
// Compiler-key dispatch is celType-narrowed:
//   FormulaCel        → metadata.parser (defaults to "f"; names the
//                       parser/compiler cel that turns the formula
//                       source into a CompiledEnvelope)
//   EditableLambdaCel → metadata.kind   (the source language tag
//                       doubles as the compiler key)
//   LockedLambdaCel   → never has source (no compile pass needed)
const resolveCompilerKey = (cel: FireableCel): Key => {
  if (cel.celType === "FormulaCel") return cel.metadata.parser ?? "f";
  return cel.metadata.kind ?? "f";
};

const writeBackCompilerKey = (cel: FireableCel, key: Key): void => {
  if (cel.celType === "FormulaCel") cel.metadata.parser = key;
  else cel.metadata.kind = key;
};


export const compileCelBody = async (
  cel: FireableCel, state: State, opts?: CompileCelBodyOpts,
): Promise<void> => {
  if (cel.f === undefined) return;

  // Consent gate: compiling a USER lambda (EditableLambdaCel — js/wat/py source)
  // RUNS code, the highest-trust capability. In a LOCKED session it needs consent
  // for that compiler kind (js/wat/py are in the standing blacklist).
  // FormulaCels (the declarative language) and the safe `formula` kind are always
  // allowed. Refuse as a value, don't abort hydrate.
  const kind = String((cel.metadata as { kind?: unknown }).kind ?? "");
  if (cel.celType === "EditableLambdaCel" && !isConsented(state, kind, cel.metadata.segment)) {
    const ce = makeCelError([cel.metadata.key], "CapabilityDeniedError",
      new Error(`Cel "${cel.metadata.key}" runs ${kind} code — not consented (open =consentpanel() to allow it)`));
    appendError(state, ce);
    cel.v = ce;
    return;
  }

  // EditableLambdaCel._compiler is a bound Recompile fn — an editor
  // surface installs it to skip the cel-registry lookup on source
  // edits. Recompile returns Fn directly (no envelope), so dispose /
  // buildEvaluate are intentionally unavailable on this path; the
  // editor owns those concerns itself if it cares. Stays sync — the
  // async story is for registry-path compilers that need lazy-loaded
  // runtimes (QuickJS, wabt.js, Pyodide); those don't fit Recompile.
  if (cel.celType === "EditableLambdaCel" && cel._compiler) {
    cel._fn = cel._compiler(cel.f);
    return;
  }

  const compilerKey = resolveCompilerKey(cel);
  const compiler = resolveFn(state, compilerKey) as Compiler | undefined;
  if (!compiler) {
    // Configuration error — the segment authoring is wrong, not the
    // cel's content. Still throws so the developer sees it during boot
    // rather than getting a silent CelError per cel. Log too so the
    // host can enumerate every missing-compiler hit if there are
    // several.
    const msg =
      `Cel "${cel.metadata.key}" has source but no compiler is registered ` +
      `at cel key "${compilerKey}".`;
    appendError(state, makeCelError([cel.metadata.key], "MissingCompilerError", new Error(msg)));
    throw new Error(msg);
  }

  // Per-compile context: cel-level hints that affect the compiled
  // wrapper. outputSchema lets composite-wasm compilers (py with
  // worker, future kinds) build a wrapper that returns a WasmHandle
  // instead of eagerly marshalling. wasmExport / imports steer the
  // wasm-bytes compiler (which export to expose, which imports-provider
  // to instantiate against). Two cels with identical source but
  // differing context need separate envelopes, so the cache key folds
  // in a stable serialization of the whole context.
  const outputSchema = resolveOutputWitType(cel, state);
  const md = cel.metadata as { wasmExport?: string; imports?: Key };
  const context: CompileContext = {};
  if (outputSchema)            context.outputSchema = outputSchema;
  if (md.wasmExport !== undefined) context.wasmExport = md.wasmExport;
  if (md.imports !== undefined)    context.imports    = md.imports;
  // The compiling cel's own key, so a FORMULA parser can resolve location-
  // relative references (infix: bare A1 → <self-segment>.A1). Only FormulaCels
  // address siblings relatively; lambda kinds (wat/js/py) don't, so they must
  // NOT fold a per-cel key into ctxKey or identical-source cels stop sharing a
  // compiled envelope. For formulas the key IS folded in, so cels in different
  // segments never share an envelope that baked in the wrong segment —
  // correctness over dedupe for these tiny formula compiles.
  if (cel.celType === "FormulaCel" && cel.metadata.key) context.selfKey = cel.metadata.key;
  const ctxKey = Object.keys(context).length ? `|${JSON.stringify(context)}` : "";

  // Compile cache lookup. Same (kind, source, context) triple → same
  // envelope. The cache stores *Promises*: two cels in the same topo
  // layer with identical source would otherwise both miss, both invoke
  // the compiler, and one overwrites the other in the cache — defeating
  // the dedupe. With promise caching, the second cel awaits the first's
  // in-flight compile. On rejection we evict so a retry isn't stuck on
  // a permanently-rejected promise.
  const cache = state.cels.get(COMPILE_CACHE_KEY)?.v as
    | Map<string, Promise<CompiledLambda>>
    | undefined;
  const cacheKey = `${compilerKey}:${cel.f}${ctxKey}`;
  if (opts?.evictCache) cache?.delete(cacheKey);

  let compiledP: Promise<CompiledLambda> | undefined = cache?.get(cacheKey);
  if (compiledP === undefined && cache) {
    compiledP = (async (): Promise<CompiledLambda> => {
      try {
        return (await compiler(cel.f, state, context)) as CompiledLambda;
      } catch (e) {
        // Evict so the next compile attempt (e.g., after the author
        // fixes the source) starts fresh.
        cache.delete(cacheKey);
        throw e;
      }
    })();
    cache.set(cacheKey, compiledP);
  } else if (compiledP === undefined) {
    // No cache cel installed — fall through to direct invocation.
    compiledP = Promise.resolve(compiler(cel.f, state, context)) as Promise<CompiledLambda>;
  }

  // Trap-as-value at compile time. If the compiler throws (bad WAT
  // syntax, malformed JS, missing import, …) the cel's v becomes a
  // CelError and the cel skips fn-binding — it stays in-error for the
  // life of the hydrate. Downstream cels see the error value at fire
  // time and propagate. Without this, one bad cel aborts hydrate of the
  // entire segment, which is hostile to incremental authoring.
  //
  // Note: a missing compiler (above) still throws — that's a setup
  // mistake, not data corruption. Same for "parser doesn't emit an
  // envelope" below — it's a configuration / contract issue. We only
  // catch errors thrown *from inside the compiler* on actual sources.
  let compiled: CompiledLambda;
  try {
    compiled = await compiledP;
  } catch (e) {
    const ce = makeCelError([cel.metadata.key], "CompileError", e);
    appendError(state, ce);
    cel.v = ce;
    return;
  }

  // FormulaCel contract: the parser must emit a CompiledEnvelope that
  // carries buildEvaluate. The formula fast path in runCycle relies on
  // it; a bare Fn (or an envelope without buildEvaluate) means the cel
  // would silently fall off the fast path. Catch it here instead.
  if (cel.celType === "FormulaCel") {
    if (typeof compiled === "function" || !compiled.buildEvaluate) {
      throw new Error(
        `FormulaCel "${cel.metadata.key}" uses parser "${compilerKey}", ` +
        `but that parser does not emit a CompiledEnvelope with ` +
        `buildEvaluate. Use a formula-shaped parser (e.g. the default "f").`,
      );
    }
  }
  if (typeof compiled === "function") {
    cel._fn = compiled;
  } else {
    cel._fn = compiled.fn;
    if (compiled.dispose)        cel._dispose       = compiled.dispose;
    if (compiled.buildEvaluate)  cel._buildEvaluate = compiled.buildEvaluate;
    if (compiled.wasm)           cel._wasm          = compiled.wasm;
    if (compiled.channels && compiled.channels.length > 0) {
      // Compiler-declared channel participation (e.g. binder forms →
      // "defn.commit"). Merge, never remove — same contract as the
      // inputMap auto-wire.
      const have = new Set(cel.metadata.channel ?? []);
      for (const k of compiled.channels) have.add(k);
      cel.metadata.channel = [...have];
    }
  }
  writeBackCompilerKey(cel, compilerKey);
  // Auto-populate inputMap only for compilers that supply extractDeps
  // (formula parsers). Lambda compilers (js, py, wat) have
  // no source-level introspection — leaving inputMap undefined keeps
  // the lambda out of the cascade unless the author explicitly opts
  // in via metadata.inputMap or dynamic. Otherwise empty-inputMap
  // lambdas would fire on every cycle with an empty inputs object,
  // and kinds that take positional args (Python) would fail when
  // handed a stray `{}`.
  if (compiler.extractDeps) {
    if (!cel.metadata.inputMap) cel.metadata.inputMap = {};
    // State is passed so range-aware parsers can resolve named ranges
    // (RangeCels) into their member keys at wire time; context carries the
    // cel's own key so relative refs wire to the right segment's siblings.
    const fresh = compiler.extractDeps(cel.f, state, context);
    if (opts?.pruneAutoWired) {
      const keep = new Set(fresh);
      for (const name of Object.keys(cel.metadata.inputMap)) {
        if (!keep.has(name) && cel.metadata.inputMap[name] === name) {
          delete cel.metadata.inputMap[name];
        }
      }
    }
    for (const dep of fresh) {
      if (!(dep in cel.metadata.inputMap)) cel.metadata.inputMap[dep] = dep;
    }
  }

  // Stamp the definition generation this cel compiled against — the
  // cascade's staleness check (卜/graph.ts isDefinitionStale) compares
  // each definition-class input's _defGen to this.
  cel._compiledGen = state.defGeneration ?? 0;
};
