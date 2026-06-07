// kernel — the kernel segment.
//
// IO, lifecycle, and segment-registry cels every host calls, plus the
// internal locked ValueCels holding state-shaped caches the kernel keeps
// off the public type, plus the cel-error trap-as-value schema + its
// protocol fns. The kernel role admits exactly one segment by rule
// (closure = {kernel}), so this single index.ts is the whole role.
//
// Two kinds of seed compose here:
//   • the native-fn cels — declared in 甲骨.json, their `_fn` bound below
//     through one bindNativeFns call (key → fn map preserved verbatim);
//   • the internal cels — built in CODE (their v's are mutable per-State
//     containers — Maps inside PrecomputedIndexes, the compile-cache Map),
//     so they can't ride as data. internalCels() is a BUILDER: each
//     createInitialState call gets its own containers.

import type {
  甲骨, Cel, CompiledLambda, Fn, Key, SegmentLoader, State, ValueCel,
} from "../../types/index.js";
import {
  getCel, setValue, setValueBatch, setCel, setCelBatch,
  touch, consume, drain,
  compileFormula, extractDeps, clearErrors,
  runCycle, interlinked, ilk, hydrate, hydrate函, dehydrate, dehydrate函,
  flush, wake, sleep, forget,
  findDependents, getSegmentManifest, listSegments,
  registerSegmentLoader, loadSegment, ensureSegments, isSegmentPending,
  cel_error_isChanged, cel_error_hydrate, cel_error_dehydrate,
  bindNativeFns,
  buildPrecomputedIndexes,
  PRECOMPUTED_STATES_KEY, COMPILE_CACHE_KEY, ERRORS_LOG_KEY,
  SEGMENT_LOADERS_KEY, BUNDLED_LOADERS_KEY,
} from "../../kernel/index.js";
import type { CelError } from "../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

export const name = "kernel" as const;

// Default formula compiler: S-expression source → CompiledLambda.
// Unlocked so hosts can swap formula languages by registering a
// replacement at "f" (with a matching .extractDeps) via setCel.
// extractDeps is consulted at compile time to auto-wire cel.inputMap
// from the formula body; state is threaded through so the parser can
// resolve named ranges (RangeCels) at compile time.
const formulaFn: Fn = (src: string, state?: State) => compileFormula(src, state);
formulaFn.extractDeps = extractDeps;

// The native-fn cels: one bindNativeFns over the merged 甲骨.json. The
// key → fn map is the concatenation (in 甲骨.json order) of what the four
// former binder files (kernel-io / -lifecycle / -segments + cel-error)
// each bound — same fn behind each key, verbatim.
export const nativeCels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  // kernel-io
  ["getCel",        getCel],
  ["setValue",      setValue],
  ["setValueBatch", setValueBatch],
  ["setCel",        setCel],
  ["setCelBatch",   setCelBatch],
  ["touch",         touch],
  ["consume",       consume],
  ["drain",         drain],
  ["clearErrors",   clearErrors],
  ["f",             formulaFn],
  // kernel-lifecycle
  ["interlinked", interlinked], // canonical — "a system of cels. interlinked."
  ["ilk",         ilk],         // short form for formulas: (ilk)
  ["runCycle",   runCycle],     // legacy alias
  ["hydrate",    hydrate],
  ["hydrate函",  hydrate函],
  ["dehydrate",  dehydrate],
  ["dehydrate函", dehydrate函 as unknown as Fn],
  ["flush",      flush],
  ["wake",       wake],
  ["sleep",      sleep],
  ["forget",     forget],
  // kernel-segments
  ["getSegmentManifest",    getSegmentManifest    as Fn],
  ["listSegments",          listSegments          as Fn],
  ["findDependents",        findDependents        as Fn],
  ["registerSegmentLoader", registerSegmentLoader as Fn],
  ["loadSegment",           loadSegment           as Fn],
  ["ensureSegments",        ensureSegments        as Fn],
  ["isSegmentPending",      isSegmentPending      as Fn],
  // cel-error: trap-as-value schema + protocol fns. Kernel-resident: cels
  // that hold CelError values attach this schema so dehydrate/isChanged
  // dispatch through cel-error_dehydrate / cel-error_isChanged.
  ["cel-error_isChanged", cel_error_isChanged],
  ["cel-error_hydrate",   cel_error_hydrate],
  ["cel-error_dehydrate", cel_error_dehydrate],
]));

// Kernel-internal seeds. Locked ValueCels holding state-shaped caches the
// kernel keeps off the public type. Today:
//   • precomputedStates — cascade indexes (Maps + Sets JSON can't carry)
//   • compile.cache     — source-hash → CompiledLambda, per kind. Read
//                         by compileCelBody to skip re-compilation when
//                         a cel's source already compiled to a known
//                         envelope (hot-reload undo, cross-cel dedupe).
//                         Keyed `${kindKey}:${source}` so the same
//                         source under different compilers caches
//                         separately.
//   • errors            — append-only CelError[]. Every trap (compile,
//                         runtime, cycle, missing-compiler) pushes here
//                         in addition to landing on cel.v / throwing,
//                         so hosts can enumerate "what's broken" in O(1)
//                         and structural errors (cycles) have a home
//                         even when no single cel owns them.
//
// All v's are mutable containers. Each State needs its own — sharing
// across States leaks across independent kernels (matters for tests,
// multi-document apps). internalCels is a builder function evaluated once
// per createInitialState call.
export const internalCels = (): Cel[] => [
  {
    celType: "ValueCel",
    metadata: { key: PRECOMPUTED_STATES_KEY, segment: "kernel" },
    v: buildPrecomputedIndexes(),
    locked: true,
  } satisfies ValueCel,
  {
    celType: "ValueCel",
    metadata: { key: COMPILE_CACHE_KEY, segment: "kernel" },
    v: new Map<string, Promise<CompiledLambda>>(),
    locked: true,
  } satisfies ValueCel,
  {
    celType: "ValueCel",
    metadata: { key: ERRORS_LOG_KEY, segment: "kernel" },
    v: [] as CelError[],
    locked: true,
  } satisfies ValueCel,
  {
    celType: "ValueCel",
    metadata: { key: SEGMENT_LOADERS_KEY, segment: "kernel" },
    v: new Map<Key, SegmentLoader>(),
    locked: true,
  } satisfies ValueCel,
  {
    // Persistent bundled-loader table — every bundled segment's code
    // loader, populated once by createInitialState. The re-park source so
    // flush/forget of a bundled segment can bring it back via loadSegment.
    celType: "ValueCel",
    metadata: { key: BUNDLED_LOADERS_KEY, segment: "kernel" },
    v: new Map<Key, SegmentLoader>(),
    locked: true,
  } satisfies ValueCel,
];

// The kernel loader: internal containers first (createInitialState relies
// on them existing before the steps that populate them), then the bound
// native-fn cels. One flat Cel[].
export const cels = (): Cel[] => [...internalCels(), ...nativeCels];
