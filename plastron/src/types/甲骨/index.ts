// 甲骨 — the dehydrated world: what a .甲 archive carries. 譜 and the
// metadata lineage live here because metadata IS the part of a cel
// that dehydrates; the live shapes in ../cels/ reference them.
export type {
  譜, Coordinate,
  BaseCelMetadata, ComputeCelMetadata, CelMetadata,
  FormulaCelMetadata, LambdaCelMetadata, ChannelCelMetadata, CompilerCelMetadata,
} from "./譜.js";
export type { CelType, DehydratedCel, DehydratedChannel } from "./dehydrated.js";
export type { SegmentRole, 冊, 甲骨 } from "./冊.js";
export type { 函, 函Boot, 函SegmentEntry, 函PayloadSource } from "./函.js";
