import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// sqlite-demo — one verb, =sqlitedemo(), that lays down a worked SQLite example
// the way a user would build one: a db handle, a CREATE-TABLE schema, a JSON
// seed, a couple of get/aggregate queries, and the client window opened on it.
// Nothing runs at boot — the segment only contributes the dormant verb; calling
// =sqlitedemo() commits the cels, whose formulas then execute through origin's
// effect drain. The chain is ORDERED by referencing the prior step (an extra,
// ignored arg that wires the inputMap edge): seed waits on create, the reads
// wait on seed.
const sqlitedemoFn: Fn = ((db: unknown): unknown => {
  const d = String(db ?? "demo");
  const rows = [
    { id: 1, name: "Speedy",  speed: 8 },
    { id: 2, name: "Pokey",   speed: 3 },
    { id: 3, name: "Shelly",  speed: 5 },
    { id: 4, name: "Crush",   speed: 9 },
  ];
  return { genesis: true, layer: "demo", cels: {
    "demo.db":     { celType: "FormulaCel", f: `=db("${d}")`, metadata: { name: "db", parser: "infix" } },
    "demo.schema": { celType: "ValueCel",   v: "CREATE TABLE IF NOT EXISTS turtles (id INTEGER PRIMARY KEY, name TEXT, speed INTEGER)", metadata: { name: "schema" } },
    "demo.create": { celType: "FormulaCel", f: `=sql(demo.db, demo.schema)`, metadata: { name: "create", parser: "infix" } },
    "demo.rows":   { celType: "ValueCel",   v: rows, metadata: { name: "rows" } },
    // seed waits on create (the demo.create ref orders it); dbseed ignores the arg
    "demo.seed":   { celType: "FormulaCel", f: `=dbseed(demo.db, demo.rows, "turtles", demo.create)`, metadata: { name: "seed", parser: "infix" } },
    // get: a couple of reads, ordered after seed
    "demo.all":    { celType: "FormulaCel", f: `=sql(demo.db, "SELECT * FROM turtles ORDER BY id", demo.seed)`, metadata: { name: "all", parser: "infix" } },
    "demo.fast":   { celType: "FormulaCel", f: `=sql(demo.db, "SELECT name, speed FROM turtles WHERE speed >= 5 ORDER BY speed DESC", demo.seed)`, metadata: { name: "fast", parser: "infix" } },
    // open the client on it
    "demo.client": { celType: "FormulaCel", f: `=sqlclient("${d}", "SQLite demo — ${d}")`, metadata: { name: "client", parser: "infix" } },
  } };
}) as Fn;

export const name = "sqlite-demo" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sqlitedemo", sqlitedemoFn],
]));
