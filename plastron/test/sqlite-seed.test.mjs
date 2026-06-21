import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildInsert, sqlLiteral, ident, shapeTable, capRows,
} from "../src/甲骨坑/library/sqlite/utils/sql-gen.ts";

// These cover the pure SQL-generation + schema-shaping logic behind the seed /
// schema verbs. The OPFS-backed engine itself is browser-only (verified in a
// real browser), but this logic is engine-independent and unit-testable here.

test("sqlLiteral quotes and escapes by type", () => {
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral(undefined), "NULL");
  assert.equal(sqlLiteral(42), "42");
  assert.equal(sqlLiteral(3.5), "3.5");
  assert.equal(sqlLiteral(NaN), "NULL");
  assert.equal(sqlLiteral(Infinity), "NULL");
  assert.equal(sqlLiteral(true), "1");
  assert.equal(sqlLiteral(false), "0");
  assert.equal(sqlLiteral("hi"), "'hi'");
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(sqlLiteral({ a: 1 }), `'{"a":1}'`);
});

test("ident double-quotes and escapes identifiers", () => {
  assert.equal(ident("users"), '"users"');
  assert.equal(ident('a"b'), '"a""b"');
});

test("buildInsert returns empty string for no rows", () => {
  assert.equal(buildInsert("t", []), "");
});

test("buildInsert builds a multi-row INSERT with column union + escaping", () => {
  const sql = buildInsert("users", [
    { id: 1, name: "Alice", age: 30 },
    { id: 2, name: "O'Brien" },          // missing age → NULL
  ]);
  assert.match(sql, /INSERT INTO "users" \("id", "name", "age"\) VALUES/);
  assert.match(sql, /\(1, 'Alice', 30\)/);
  assert.match(sql, /\(2, 'O''Brien', NULL\)/);
  assert.ok(sql.trim().endsWith(";"));
});

test("buildInsert picks up columns first-seen across later rows", () => {
  const sql = buildInsert("t", [{ a: 1 }, { a: 2, b: 3 }]);
  assert.match(sql, /\("a", "b"\)/);
  assert.match(sql, /\(1, NULL\)/);
  assert.match(sql, /\(2, 3\)/);
});

test("shapeTable shapes PRAGMA rows into columns + PK/FK", () => {
  const t = shapeTable(
    "orders",
    [
      { cid: 0, name: "id", type: "INTEGER", notnull: 1, pk: 1 },
      { cid: 1, name: "user_id", type: "INTEGER", notnull: 0, pk: 0 },
    ],
    [{ id: 0, seq: 0, table: "users", from: "user_id", to: "id" }],
  );
  assert.equal(t.name, "orders");
  assert.deepEqual(t.columns[0], { name: "id", type: "INTEGER", pk: true, notnull: true });
  assert.deepEqual(t.columns[1], { name: "user_id", type: "INTEGER", pk: false, notnull: false });
  assert.deepEqual(t.fks, [{ from: "user_id", table: "users", to: "id" }]);
});

test("capRows caps at the limit and flags truncation", () => {
  const big = Array.from({ length: 150 }, (_, i) => i);
  const capped = capRows(big, 100);
  assert.equal(capped.rows.length, 100);
  assert.equal(capped.truncated, true);
  const small = capRows([1, 2, 3], 100);
  assert.equal(small.truncated, false);
  assert.equal(small.rows.length, 3);
});
