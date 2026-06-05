import type { z } from "zod";
import type { Key } from "../index.js";
import type { BaseCelMetadata } from "../甲骨/index.js";
import type { WitType } from "../wit.js";
import type { BaseCel } from "./baseCel.js";

export interface Schema {
  key: Key;
  zod: z.core.JSONSchema.JSONSchema;
  protocols: {
    isChanged?: Key;
    /** Operates on cel.v at hydrate time. JSON → live value. */
    hydrate?: Key;
    /** Inverse of hydrate. Live value → JSON. */
    dehydrate?: Key;
    /** Operates on cel.f at dehydrate time, for fireable cels only
     *  (e.g. split multi-line source into string[] for readable .json). */
    sourceDehydrate?: Key;
    dispose?: Key;
    [k: string]: Key | undefined;
  };
  /** Absent / "zod" validates JS values via `zod`. "wasm" marks the
   *  cel as living in a wasm domain. */
  kind?: "zod" | "wasm";
  /** Present when kind === "wasm" — the WIT type of the cel's value. */
  wit?: WitType;
  /** When true, ref-eq is sound for using this schema's values as L1
   *  cache keys. Defaults to false (conservative). */
  memoSafe?: boolean;
}

/** DEFINITION plane. v carries the Schema struct itself. */
export interface SchemaCel extends BaseCel {
  celType: "SchemaCel";
  metadata: BaseCelMetadata;
  v: Schema;
}

export type ZodToJsonSchema = (schema: z.ZodType) => z.core.JSONSchema.JSONSchema;
export type JsonSchemaToZod = (json: z.core.JSONSchema.JSONSchema) => z.ZodType;
