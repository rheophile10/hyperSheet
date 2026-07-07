import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// NanoSteg core round-trip WITHOUT any canvas: hand-build an RGBA buffer, run
// the WAT-native blind steg through the nanosteg.* marshalling verbs. Proves
// (b) blind embed→decode recovers the link from the steg image ALONE + password
// (no cover), (c) wrong password → clean magic-miss message, (d) capacity guard.
//
// The algorithm is the WAT SOURCE below — the same module that lives on the
// nanosteg sheet (kind:"wat", imports:"nanosteg.host"). The nanosteg.host hook
// captures its live instance; embed/decode marshal bytes to/from its memory.

const NANOSTEG_WAT = `
(module
  (memory (export "mem") 1)
  (global $seed  (mut i64) (i64.const 0))
  (global $state (mut i64) (i64.const 0))

  (func (export "hash_password") (param $ptr i32) (param $len i32)
    (local $h i64) (local $i i32)
    (local.set $h (i64.const 0xCBF29CE484222325))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (local.set $h (i64.xor (local.get $h)
        (i64.extend_i32_u (i32.load8_u (i32.add (local.get $ptr) (local.get $i))))))
      (local.set $h (i64.mul (local.get $h) (i64.const 0x100000001B3)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (global.set $seed (local.get $h)))

  (func $next (result i64)
    (local $z i64)
    (global.set $state (i64.add (global.get $state) (i64.const 0x9E3779B97F4A7C15)))
    (local.set $z (global.get $state))
    (local.set $z (i64.mul (i64.xor (local.get $z) (i64.shr_u (local.get $z) (i64.const 30))) (i64.const 0xBF58476D1CE4E5B9)))
    (local.set $z (i64.mul (i64.xor (local.get $z) (i64.shr_u (local.get $z) (i64.const 27))) (i64.const 0x94D049BB133111EB)))
    (i64.xor (local.get $z) (i64.shr_u (local.get $z) (i64.const 31))))

  (func $is_used (param $idx i32) (result i32)
    (i32.and (i32.shr_u
      (i32.load8_u (i32.add (i32.const 0x800000) (i32.shr_u (local.get $idx) (i32.const 3))))
      (i32.and (local.get $idx) (i32.const 7))) (i32.const 1)))
  (func $mark (param $idx i32)
    (local $addr i32)
    (local.set $addr (i32.add (i32.const 0x800000) (i32.shr_u (local.get $idx) (i32.const 3))))
    (i32.store8 (local.get $addr)
      (i32.or (i32.load8_u (local.get $addr))
        (i32.shl (i32.const 1) (i32.and (local.get $idx) (i32.const 7))))))
  (func $clear_bitset (param $C i32)
    (memory.fill (i32.const 0x800000) (i32.const 0)
      (i32.div_u (i32.add (local.get $C) (i32.const 7)) (i32.const 8))))

  (func $claim (param $C i32) (result i32)
    (local $idx i32)
    (local.set $idx (i32.wrap_i64 (i64.rem_u (call $next) (i64.extend_i32_u (local.get $C)))))
    (block $found (loop $lp
      (br_if $found (i32.eqz (call $is_used (local.get $idx))))
      (local.set $idx (i32.rem_u (i32.add (local.get $idx) (i32.const 1)) (local.get $C)))
      (br $lp)))
    (call $mark (local.get $idx))
    (local.get $idx))

  (func $carrier_off (param $idx i32) (result i32)
    (i32.add (i32.mul (i32.div_u (local.get $idx) (i32.const 3)) (i32.const 4))
             (i32.rem_u (local.get $idx) (i32.const 3))))
  (func $put_bit (param $idx i32) (param $b i32)
    (local $off i32)
    (local.set $off (call $carrier_off (local.get $idx)))
    (i32.store8 (local.get $off)
      (i32.or (i32.and (i32.load8_u (local.get $off)) (i32.const 0xFE))
              (i32.and (local.get $b) (i32.const 1)))))
  (func $get_bit (param $idx i32) (result i32)
    (i32.and (i32.load8_u (call $carrier_off (local.get $idx))) (i32.const 1)))

  (func (export "embed") (param $w i32) (param $h i32) (param $len i32) (result i32)
    (local $C i32) (local $K i32) (local $i i32) (local $byte i32) (local $bit i32) (local $bi i32)
    (local.set $C (i32.mul (i32.const 3) (i32.mul (local.get $w) (local.get $h))))
    (local.set $K (i32.add (i32.const 56) (i32.mul (i32.const 8) (local.get $len))))
    (if (i32.gt_u (local.get $K) (local.get $C)) (then (return (i32.const -1))))
    (i32.store8 (i32.const 0xB00000) (i32.const 0x4E))
    (i32.store8 (i32.const 0xB00001) (i32.const 0x53))
    (i32.store8 (i32.const 0xB00002) (i32.const 0x01))
    (i32.store offset=0xB00003 align=1 (i32.const 0) (local.get $len))
    (global.set $state (global.get $seed))
    (call $clear_bitset (local.get $C))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $K)))
      (local.set $bi (i32.shr_u (local.get $i) (i32.const 3)))
      (local.set $byte (if (result i32) (i32.lt_u (local.get $bi) (i32.const 7))
        (then (i32.load8_u (i32.add (i32.const 0xB00000) (local.get $bi))))
        (else (i32.load8_u (i32.add (i32.const 0xA10000) (i32.sub (local.get $bi) (i32.const 7)))))))
      (local.set $bit (i32.and (i32.shr_u (local.get $byte) (i32.and (local.get $i) (i32.const 7))) (i32.const 1)))
      (call $put_bit (call $claim (local.get $C)) (local.get $bit))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (i32.const 0))

  (func (export "decode") (param $w i32) (param $h i32) (result i32)
    (local $C i32) (local $i i32) (local $bit i32) (local $len i32) (local $total i32) (local $bi i32)
    (local.set $C (i32.mul (i32.const 3) (i32.mul (local.get $w) (local.get $h))))
    (global.set $state (global.get $seed))
    (call $clear_bitset (local.get $C))
    (i64.store (i32.const 0xB00000) (i64.const 0))
    (local.set $i (i32.const 0))
    (block $hd (loop $hl
      (br_if $hd (i32.ge_u (local.get $i) (i32.const 56)))
      (local.set $bit (call $get_bit (call $claim (local.get $C))))
      (if (local.get $bit) (then
        (local.set $bi (i32.add (i32.const 0xB00000) (i32.shr_u (local.get $i) (i32.const 3))))
        (i32.store8 (local.get $bi) (i32.or (i32.load8_u (local.get $bi))
          (i32.shl (i32.const 1) (i32.and (local.get $i) (i32.const 7)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $hl)))
    (if (i32.ne (i32.load8_u (i32.const 0xB00000)) (i32.const 0x4E)) (then (return (i32.const -1))))
    (if (i32.ne (i32.load8_u (i32.const 0xB00001)) (i32.const 0x53)) (then (return (i32.const -1))))
    (if (i32.ne (i32.load8_u (i32.const 0xB00002)) (i32.const 0x01)) (then (return (i32.const -1))))
    (local.set $len (i32.load offset=0xB00003 align=1 (i32.const 0)))
    (local.set $total (i32.add (i32.const 56) (i32.mul (i32.const 8) (local.get $len))))
    (if (i32.gt_u (local.get $total) (local.get $C)) (then (return (i32.const -2))))
    (memory.fill (i32.const 0xA10000) (i32.const 0) (local.get $len))
    (local.set $i (i32.const 0))
    (block $pd (loop $pl
      (br_if $pd (i32.ge_u (local.get $i) (i32.mul (i32.const 8) (local.get $len))))
      (local.set $bit (call $get_bit (call $claim (local.get $C))))
      (if (local.get $bit) (then
        (local.set $bi (i32.add (i32.const 0xA10000) (i32.shr_u (local.get $i) (i32.const 3))))
        (i32.store8 (local.get $bi) (i32.or (i32.load8_u (local.get $bi))
          (i32.shl (i32.const 1) (i32.and (local.get $i) (i32.const 7)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $pl)))
    (local.get $len))
)
`;

const isCelError = (v) => v && typeof v === "object" && v.kind === "error";

const makeCover = (w, h, seed = 42) => {
  const a = new Uint8Array(w * h * 4);
  let s = seed >>> 0;
  for (let i = 0; i < a.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    a[i] = i % 4 === 3 ? 255 : (s & 0xff);
  }
  return a;
};

// Boot a State with the NanoSteg WAT core compiled and its instance captured.
const boot = async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{
    name: "nano",
    cels: [
      { key: "nanosteg.core", celType: "EditableLambdaCel",
        metadata: { key: "nanosteg.core", segment: "nano", kind: "wat",
                    wasmExport: "embed", imports: "nanosteg.host" },
        f: NANOSTEG_WAT },
    ],
  }], [{ name: "nano", version: "0.0.1", description: "test", dependencies: ["nanosteg", "wat-compiler"] }]);
  // Formula verbs recover State via globalThis.plastron.state (doom idiom).
  globalThis.plastron = { ...(globalThis.plastron ?? {}), state };
  return state;
};

test("BLIND round-trip: a #f= link is recovered from the steg image alone + password", async () => {
  const state = await boot();
  const embed = resolveFn(state, "nanosteg.embed");
  const decode = resolveFn(state, "nanosteg.decode");
  const core = state.cels.get("nanosteg.core")._fn;

  const w = 96, h = 96;
  const cover = makeCover(w, h);
  const link = "https://plastron.ca/#f=eNqrVkrKT8pJTS7JzM9TslJQSszLzMtMzs8rVtJRSkksSVWyUkrOSCzKTC1WsjKvBQBc_g8b";

  const steg = embed(cover, w, h, link, "SECRET_PASSWORD", core);
  assert.ok(!isCelError(steg), `embed should succeed: ${JSON.stringify(steg)}`);
  assert.ok(steg instanceof Uint8Array, "embed returns the steg RGBA buffer");

  // BLIND: decode is handed only the steg buffer + password — no cover argument.
  const recovered = decode(steg, w, h, "SECRET_PASSWORD", core);
  assert.equal(recovered, link, "the exact link is recovered from the image alone");

  // alpha never touched; only R/G/B LSBs changed
  let alphaOK = true, onlyLSB = true;
  for (let i = 0; i < steg.length; i++) {
    if (i % 4 === 3) { if (steg[i] !== cover[i]) alphaOK = false; }
    else if (((steg[i] ^ cover[i]) & 0xFE) !== 0) onlyLSB = false;
  }
  assert.ok(alphaOK, "alpha channel is never modified");
  assert.ok(onlyLSB, "only R/G/B LSBs are modified");
});

test("wrong password → a clean magic-miss message, not a crash", async () => {
  const state = await boot();
  const embed = resolveFn(state, "nanosteg.embed");
  const decode = resolveFn(state, "nanosteg.decode");
  const core = state.cels.get("nanosteg.core")._fn;

  const w = 96, h = 96, cover = makeCover(w, h, 5);
  const steg = embed(cover, w, h, "https://plastron.ca/#f=abc", "correct horse", core);
  const out = decode(steg, w, h, "battery staple", core);
  assert.equal(typeof out, "string");
  assert.match(out, /wrong password/i, `should report wrong password, got: ${out}`);
});

test("capacity guard: a payload larger than the carriers is refused (CelError)", async () => {
  const state = await boot();
  const embed = resolveFn(state, "nanosteg.embed");
  const core = state.cels.get("nanosteg.core")._fn;

  // 4×4 → C = 48 carriers; the 56-bit header alone overflows it.
  const out = embed(makeCover(4, 4), 4, 4, "way too much payload for sixteen pixels", "pw", core);
  assert.ok(isCelError(out), "oversized payload should yield a CelError");
  assert.match(out.message, /fit|capacity/i);
});

test("empty and unicode payloads both round-trip", async () => {
  const state = await boot();
  const embed = resolveFn(state, "nanosteg.embed");
  const decode = resolveFn(state, "nanosteg.decode");
  const core = state.cels.get("nanosteg.core")._fn;
  const w = 96, h = 96;

  const e0 = embed(makeCover(w, h, 1), w, h, "", "p", core);
  assert.equal(decode(e0, w, h, "p", core), "", "empty payload round-trips");

  const uni = "héllo → 世界 🐸 plastron";
  const e1 = embed(makeCover(w, h, 2), w, h, uni, "pw", core);
  assert.equal(decode(e1, w, h, "pw", core), uni, "unicode payload round-trips byte-for-byte");
});
