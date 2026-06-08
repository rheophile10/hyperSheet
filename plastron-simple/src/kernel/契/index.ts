// 契 — inputs into the live state. Two mutually exclusive
// write tiers, selected by WHAT you are writing, not how:
//
//   DATA  (recalc tier)     setValue / setValueBatch — a ValueCel's v
//         or a FormulaCel's f (its source is its content). Consumers
//         only ever RECALCULATE: nothing compiles against data. These
//         are also the only cels that carry coordinates.
//
//   CELS  (recompile tier)  setCel / setCelBatch — cels as structure.
//         With celType: create/replace the whole cel (subsumes the old
//         registerLambda); replacing a definition cel bumps the state's
//         defGeneration so compiled consumers RECOMPILE at their next
//         fire. Without celType: metadata-only edit; v/f refused.
//
// One read: getCel returns the live Cel — take .v from it.
//
//   channels — out-of-band queues: touch enqueues, consume/drain empty,
//   flushChannels drains to fixed point per a FlushSpec.

export { getCel, setValue, setValueBatch } from "./value.js";
export { setCel, setCelBatch } from "./cel.js";
export { touch, consume, drain } from "./touch.js";
export { flushChannels } from "./flush-channels.js";
