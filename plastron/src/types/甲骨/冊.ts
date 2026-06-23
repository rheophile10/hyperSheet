import type { Key } from "../index.js";
import type { DehydratedCel } from "./dehydrated.js";
import type { 譜 } from "./譜.js";

/** Segment role. Drives lifecycle (boot vs eager vs explicit-start
 *  vs explicit-open), dehydrate inclusion, and flush protection.
 *  `"user"` = a genesis-minted, app-less document segment (kind names the
 *  generator: workbook/winapp/wasm/…). `"user-space"` = an app-bound session
 *  document (must declare `applications`). The two are distinct, not aliases. */
export type SegmentRole = "kernel" | "library" | "application" | "user" | "user-space";

export interface 冊 extends 譜 {
  name: string;
  version: string;
  dependencies: Key[];
  /** `applyManifestDefaults` fills in "library" if absent at hydrate
   *  time, preserving back-compat for legacy unclassified manifests. */
  role?: SegmentRole;
  /** Application affinity. REQUIRED on user-space (names parent app);
   *  optional on libraries; conventionally absent on kernel + application. */
  applications?: Key[];
  /** Materializer binding — names the segment's generator/contract type
   *  (workbook/winapp/wasm/… for genesis docs; "origin-application" /
   *  "origin-user" for the origin lifecycle). Drives the per-kind contract. */
  kind?: string;
  /** Content hash of the dehydrated segment — version identity + integrity.
   *  Computed at save. */
  sha?: string;
  /** Provenance / re-fetch source (e.g. a github or plastron.ca URL). */
  url?: string;
  /** ORIGIN: an origin-application's backwards-compatible sha list — the
   *  shas of older app versions whose origin-user segments this app can
   *  still load. The load gate checks a pinned applicationSha against the
   *  app's current sha OR this list. */
  compat?: string[];
  /** ORIGIN: an origin-user's pinned parent-application content hash, paired
   *  with `applications[0]` (the parent name). The load gate refuses if it
   *  matches neither the app's current sha nor the app's `compat` list. */
  applicationSha?: string;
}

export interface 甲骨 {
  name: Key;
  cels: DehydratedCel[];
}
