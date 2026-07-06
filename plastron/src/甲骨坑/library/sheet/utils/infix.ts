import type { CompileContext, CompiledEnvelope, CompiledLambda, Fn, Key, ResolvedInputs, State } from "../../../../types/index.js";
import type { CelError } from "../../../../kernel/index.js";
import { isCelError } from "../../../../kernel/index.js";
import { cellKey, expandRange, indexToCol, parseRef } from "./address.js";

// ============================================================================
// Infix formula parser — Excel-style `=A1*2` compiled into the FormulaCel
// CompiledEnvelope the kernel expects (fn + buildEvaluate), with extractDeps
// resolving A1-style references to sibling cell keys (A1 → sheet.A1) so
// hydrate auto-wires them into inputMap.
//
// A source without a leading `=` is a literal constant (number if numeric,
// else string) — though literal cells are normally ValueCels, a FormulaCel
// carrying a bare literal compiles to that constant for robustness.
//
// Supported: + - * / (arithmetic), & (string concat), = <> < > <= >=
// (comparison), unary -, parentheses, cell refs (A1), ranges (A1:B2, in
// function args), numbers, "strings", and the Excel v1 builtin function
// set (BUILTIN_CALLS below): SUM/MIN/MAX/AVG/IF plus math/rounding,
// predicate aggregation (COUNTIF/SUMIF/…), lookup (VLOOKUP/HLOOKUP/INDEX/
// MATCH), logical (AND/OR/NOT/IFS/IFERROR), text (LEFT/MID/CONCAT/…) and
// the pure DATE(y,m,d). Functions are evaluated INLINE (not cel calls),
// so the only dependencies are the cell references inside their args —
// collectDeps skips every BUILTIN_CALLS name (no phantom function-cel
// edge). Excel error VALUES (#N/A, #DIV/0!, #REF!, #VALUE!, #NUM!) are
// produced as the kernel's CelError (trap codes na/div0/ref/value/num)
// so they propagate and render like every other cel error.
//
// DELIBERATELY EXCLUDED — volatile clock fns TODAY()/NOW(): they read the
// wall clock, making a "pure" inline formula depend on invisible ambient
// state. The value would never recompute when the day rolls over (no dep
// fires) and any replay/reproducibility story breaks. They are NOT
// builtins; `=TODAY()` falls through to the undefined-symbol path and
// surfaces as #NAME?. A future clock-cel (`=A1 - clock`) keeps the
// dependency visible and reactive; see excel-formulas-segment.md. DATE
// from literal args is pure, so it stays.
// ============================================================================

type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "ref"; ref: string; key?: string }      // key set for cross-sheet Seg!A1
  | { t: "range"; range: string; keys?: string[] } // keys set for cross-sheet / named ranges
  | { t: "sym"; name: string }                     // bare non-ref name → cel value by key
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "un"; op: string; e: Node }
  | { t: "obj"; entries: { key: string; value: Node }[] } // { color: "tomato", "font-size": A1 }
  | { t: "list"; items: Node[] }                   // [1, "two", A1] — a literal array value
  | { t: "member"; base: Node; key: string }       // A1.test — property of the base's value
  | { t: "index"; base: Node; e: Node }            // A1[0] — 0-based; negatives count from the end
  | { t: "slice"; base: Node; from?: Node; to?: Node } // A1[1:3] / A1[:2] / A1[-2:] — JS slice semantics
  | { t: "call"; name: string; args: Node[] };

// ── tokenizer ────────────────────────────────────────────────────────────────

type Tok = { k: string; v: string };

const OPS2 = new Set(["<>", "<=", ">="]);

const tokenize = (src: string): Tok[] => {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === '"' || c === "'") {
      const q = c;                 // ' OR " delimits a string — so a nested formula
      let j = i + 1, s = "";       // needs no escaping: at("A1", '=dom("h1","x")').
      // backslash escapes the next char literally — so a string can also hold its
      // own delimiter (\" / \') or a backslash (\\), e.g. cel("cel(\"banana\")").
      while (j < n && src[j] !== q) {
        if (src[j] === "\\" && j + 1 < n) { s += src[j + 1]; j += 2; }
        else { s += src[j]; j++; }
      }
      toks.push({ k: "str", v: s });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.has(two)) { toks.push({ k: "op", v: two }); i += 2; continue; }
    if ("+-*/&=<>(),:!{}[]".includes(c)) { toks.push({ k: "op", v: c }); i++; continue; }
    // A lone "." (not starting a number) is the postfix member operator —
    // it appears after a "]" or ")" in chains like A1[0].name.
    if (c === "." && !(src[i + 1]! >= "0" && src[i + 1]! <= "9")) {
      toks.push({ k: "op", v: "." }); i++; continue;
    }
    if ((c >= "0" && c <= "9") || c === ".") {
      let j = i;
      while (j < n && ((src[j]! >= "0" && src[j]! <= "9") || src[j] === ".")) j++;
      toks.push({ k: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z")) {
      // A name may carry dots/underscores so namespaced cel keys are
      // referenceable (viewport.mobile, trust.kernel). `-` is excluded — it is
      // the subtraction operator (a-b stays a minus b); hyphenated keys need
      // the S-expr surface. A trailing dot isn't a key char, so don't eat it.
      let j = i;
      while (j < n && /[A-Za-z0-9_.]/.test(src[j]!)) j++;
      while (j > i + 1 && src[j - 1] === ".") j--;   // give back a trailing dot
      toks.push({ k: "name", v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`infix: unexpected character "${c}" in "${src}"`);
  }
  return toks;
};

// ── recursive-descent parser ──────────────────────────────────────────────────
//
// Precedence low→high: comparison < concat(&) < additive < multiplicative
// < unary < primary.

// Wrap a base node in one member node per path component (A1.users.name →
// member(member(ref A1, "users"), "name")). Empty path returns the base.
const memberChain = (base: Node, path: string[]): Node =>
  path.reduce<Node>((b, key) => ({ t: "member", base: b, key }), base);

const parseToks = (toks: Tok[], state?: State): Node => {
  let pos = 0;

  
  
  
  const peek = (): Tok | undefined => { return toks[pos]; }
  const next = (): Tok | undefined => { return toks[pos++]; }
  const eat = (v: string): void => {
    const t = next();
    if (!t || t.v !== v) throw new Error(`infix: expected "${v}"`);
  }

  const parse = (): Node => {
    const node = comparison();
    if (pos < toks.length) throw new Error("infix: trailing tokens");
    return node;
  }

  const comparison = (): Node => {
    let l = concat();
    for (;;) {
      const t = peek();
      if (t?.k === "op" && (t.v === "=" || t.v === "<>" || t.v === "<" || t.v === ">" || t.v === "<=" || t.v === ">=")) {
        next();
        l = { t: "bin", op: t.v, l, r: concat() };
      } else break;
    }
    return l;
  }
  // Operator dispatch must check k === "op": a STRING literal whose value
  // happens to be an operator char (e.g. the TEXTJOIN delimiter "-", or
  // "&"/"+") tokenizes as { k: "str" } and must NOT be mistaken for the
  // operator. (Pre-existing latent bug: `=SUM("-", 1)` parsed the str as a
  // unary minus and threw "unexpected token ,". Surfaced by the Excel text
  // builtins, which pass operator-char delimiters.)
  const opv = (): string | undefined => { const t = peek(); return t?.k === "op" ? t.v : undefined; }
  const concat = (): Node => {
    let l = additive();
    while (opv() === "&") { next(); l = { t: "bin", op: "&", l, r: additive() }; }
    return l;
  }
  const additive = (): Node => {
    let l = multiplicative();
    for (;;) {
      const v = opv();
      if (v === "+" || v === "-") { next(); l = { t: "bin", op: v, l, r: multiplicative() }; }
      else break;
    }
    return l;
  }
  const multiplicative = (): Node => {
    let l = unary();
    for (;;) {
      const v = opv();
      if (v === "*" || v === "/") { next(); l = { t: "bin", op: v, l, r: unary() }; }
      else break;
    }
    return l;
  }
  const unary = (): Node => {
    const v = opv();
    if (v === "-" || v === "+") { next(); return { t: "un", op: v!, e: unary() }; }
    return postfix();
  }
  // Postfix access binds tightest: .member, [index], [from:to] chain onto any
  // primary — A1.users[0].name, foo(x).bar, B2[-1]. Indexing is 0-BASED (the
  // bracket surface is JS/Python-domain; INDEX() stays 1-based Excel-domain).
  const postfix = (): Node => postfixOps(primary());
  const postfixOps = (start: Node): Node => {
    let base = start;
    for (;;) {
      const v = opv();
      if (v === ".") {
        next();
        const nt = next();
        if (!nt || nt.k !== "name") throw new Error("infix: expected a member name after \".\"");
        // The name token may itself carry dots (A1[0].user.name lexes ".": "user.name").
        for (const part of nt.v.split(".")) base = { t: "member", base, key: part };
        continue;
      }
      if (v === "[") {
        next();
        // [:to] / [from:to] / [from:] / [:] are slices; [expr] is an index.
        let from: Node | undefined, to: Node | undefined;
        if (opv() !== ":") from = comparison();
        if (opv() === ":") {
          next();
          if (opv() !== "]") to = comparison();
          eat("]");
          base = { t: "slice", base, from, to };
        } else {
          eat("]");
          if (!from) throw new Error("infix: empty index");
          base = { t: "index", base, e: from };
        }
        continue;
      }
      return base;
    }
  }
  // A range in EXPRESSION position is recognized only when it is ACCESSED —
  // D1:D9.age / D1:D9[0] — i.e. the end ref carries a dotted member tail or
  // the next token opens a postfix. A bare `ref : ref` anywhere else keeps its
  // existing meanings (slice endpoints inside [ ], plain range arguments).
  const accessedRange = (fromAddr: string, seg?: string): Node | undefined => {
    if (peek()?.v !== ":") return undefined;
    const endTok = toks[pos + 1];
    if (endTok?.k !== "name") return undefined;
    const [endHead = "", ...tail] = endTok.v.split(".");
    if (!parseRef(endHead)) return undefined;
    const after = toks[pos + 2];
    if (tail.length === 0 && after?.v !== "[" && after?.v !== ".") return undefined;
    next(); next(); // consume ":" and the end ref
    const range = `${fromAddr}:${endHead.toUpperCase()}`;
    const node: Node = seg
      ? { t: "range", range, keys: expandRange(range).map((a) => `${seg}.${a}`) }
      : { t: "range", range };
    return memberChain(node, tail);
  };
  const primary = (): Node => {
    const t = next();
    if (!t) throw new Error("infix: unexpected end");
    if (t.k === "num") return { t: "num", v: parseFloat(t.v) };
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.v === "(") { const e = comparison(); eat(")"); return e; }
    // object literal — { key: expr, "hyphen-key": expr, … }. Keys are bare
    // names or strings; values are full expressions, so a cel ref in a value
    // stays a real dependency (style({ color: A1 }) wires A1).
    if (t.v === "{") {
      const entries: { key: string; value: Node }[] = [];
      if (peek()?.v !== "}") {
        for (;;) {
          const kt = next();
          if (!kt || (kt.k !== "name" && kt.k !== "str")) throw new Error("infix: object key expected");
          eat(":");
          entries.push({ key: kt.v, value: comparison() });
          if (peek()?.v === ",") { next(); continue; }
          break;
        }
      }
      eat("}");
      return { t: "obj", entries };
    }
    // list literal — [1, "two", A1, [2, 3]]. Items are full expressions, so a
    // cel ref inside stays a real dependency. (In postfix position [ is
    // indexing — that's handled by postfix() before primary() ever sees it.)
    if (t.v === "[") {
      const items: Node[] = [];
      if (peek()?.v !== "]") {
        items.push(comparison());
        while (peek()?.v === ",") { next(); items.push(comparison()); }
      }
      eat("]");
      return { t: "list", items };
    }
    if (t.k === "name") {
      // Function call?
      if (peek()?.v === "(") {
        next(); // (
        const args: Node[] = [];
        if (peek()?.v !== ")") {
          args.push(argument());
          while (peek()?.v === ",") { next(); args.push(argument()); }
        }
        eat(")");
        return { t: "call", name: t.v, args };
      }
      const upper = t.v.toUpperCase();
      if (upper === "TRUE") return { t: "bool", v: true };
      if (upper === "FALSE") return { t: "bool", v: false };
      // Cross-sheet reference: Seg!A1 (coordinate-convergence step 3).
      // The segment keeps its case; member keys are `<segment>.<ADDR>`.
      // A dotted tail is member access on the cell's value: fish!A1.age.
      if (peek()?.v === "!") {
        next(); // !
        const refTok = next();
        const [head = "", ...path] = refTok?.k === "name" ? refTok.v.split(".") : [];
        if (!refTok || !parseRef(head)) {
          throw new Error(`infix: expected a cell ref after "${t.v}!"`);
        }
        const addr = head.toUpperCase();
        if (path.length === 0) {
          const r = accessedRange(addr, t.v);
          if (r) return r;
        }
        return memberChain({ t: "ref", ref: addr, key: `${t.v}.${addr}` }, path);
      }
      if (parseRef(t.v)) {
        const r = accessedRange(t.v.toUpperCase());
        return r ?? { t: "ref", ref: t.v.toUpperCase() };
      }
      // A dotted name that IS an exact live cel key resolves as that cel —
      // even when its head looks like an A1 ref. Without this, a sheet named
      // `sheet1` poisons every `sheet1.dims`-style reference into member
      // access on the phantom cell SHEET1 (column SHEET, row 1).
      if (t.v.includes(".") && state?.cels.has(t.v)) return { t: "sym", name: t.v };
      // A dotted name whose HEAD is a cell ref is member access on that
      // cell's value (A1.test → the "test" key of A1's dict). Non-ref heads
      // keep their existing meaning: an exact namespaced cel key
      // (viewport.mobile, fg.g1.spec) — those cels resolve as one symbol.
      if (t.v.includes(".")) {
        const [head = "", ...path] = t.v.split(".");
        if (parseRef(head)) return memberChain({ t: "ref", ref: head.toUpperCase() }, path);
      }
      // Bare symbol — a cel reference by exact key (named ranges resolve
      // at compile via resolveSymbols; anything else reads the cel's v).
      return { t: "sym", name: t.v };
    }
    throw new Error(`infix: unexpected token "${t.v}"`);
  }
  // An argument may be a range (A1:B2 / Seg!A1:B3) or an expression. A range's
  // end ref may carry a member tail (D1:D9.age) and further postfix ops.
  const rangeHead = (tok: Tok | undefined): string | undefined => {
    if (tok?.k !== "name") return undefined;
    const head = tok.v.split(".")[0]!;
    return parseRef(head) ? head : undefined;
  };
  const argument = (): Node => {
    const t = peek();
    // Seg!A1:B3 — lookahead: name ! name : name
    if (t?.k === "name" && !parseRef(t.v) && toks[pos + 1]?.v === "!"
        && toks[pos + 2]?.k === "name" && parseRef(toks[pos + 2]!.v)
        && toks[pos + 3]?.v === ":" && rangeHead(toks[pos + 4])) {
      const seg = next()!.v; next(); // seg !
      const from = next()!.v.toUpperCase(); next(); // from :
      const endTok = next()!;
      const [endHead = "", ...tail] = endTok.v.split(".");
      const to = endHead.toUpperCase();
      const keys = expandRange(`${from}:${to}`).map((addr) => `${seg}.${addr}`);
      return postfixOps(memberChain({ t: "range", range: `${from}:${to}`, keys }, tail));
    }
    if (t?.k === "name" && parseRef(t.v) && toks[pos + 1]?.v === ":") {
      const from = next()!.v;
      eat(":");
      const to = next();
      const [endHead = "", ...tail] = to?.k === "name" ? to.v.split(".") : [];
      if (!to || !parseRef(endHead)) throw new Error("infix: bad range");
      const node: Node = { t: "range", range: `${from.toUpperCase()}:${endHead.toUpperCase()}` };
      return postfixOps(memberChain(node, tail));
    }
    return comparison();
  }
  return parse();
};

// ── evaluation ────────────────────────────────────────────────────────────────

type Lookup = (key: Key) => unknown;

const num = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};

const rangeValues = (range: string, lookup: Lookup): unknown[] =>
  expandRange(range).map((addr) => lookup(cellKey(addr)));

const evalNode = (node: Node, lookup: Lookup): unknown => {
  switch (node.t) {
    case "num": return node.v;
    case "str": return node.v;
    case "bool": return node.v;
    case "ref": return lookup(node.key ?? cellKey(node.ref));
    case "range":
      return node.keys ? node.keys.map(lookup) : rangeValues(node.range, lookup);
    case "sym": return lookup(node.name);
    case "un": return node.op === "-" ? -num(evalNode(node.e, lookup)) : num(evalNode(node.e, lookup));
    case "bin": {
      const op = node.op;
      const lraw = evalNode(node.l, lookup);
      const rraw = evalNode(node.r, lookup);
      // First-error-wins propagation (Excel): a CelError operand makes the
      // whole expression that error, so IFERROR can catch it.
      if (isCelError(scalar(lraw))) return scalar(lraw);
      if (isCelError(scalar(rraw))) return scalar(rraw);
      if (op === "&") return String(scalar(lraw)) + String(scalar(rraw));
      const l = lraw;
      const r = rraw;
      switch (op) {
        case "+": return num(l) + num(r);
        case "-": return num(l) - num(r);
        case "*": return num(l) * num(r);
        case "/": return num(r) === 0 ? DIV0() : num(l) / num(r);
        case "=": return scalar(l) === scalar(r);
        case "<>": return scalar(l) !== scalar(r);
        case "<": return num(l) < num(r);
        case ">": return num(l) > num(r);
        case "<=": return num(l) <= num(r);
        case ">=": return num(l) >= num(r);
      }
      return null;
    }
    case "obj": {
      const o: Record<string, unknown> = {};
      for (const e of node.entries) o[e.key] = evalNode(e.value, lookup);
      return o;
    }
    case "list": return node.items.map((it) => evalNode(it, lookup));
    case "member": {
      const b = evalNode(node.base, lookup);
      if (isCelError(b)) return b;
      // null/undefined-safe (like ?.): an empty cell reads as blank, not an error.
      if (b === null || b === undefined) return undefined;
      // BROADCAST: member access over a collection maps per item — a range of
      // dict cells (=D1:D9.age) and an array-of-dicts value behave identically.
      // Empty items (null/undefined/"" — an over-selected range) are skipped;
      // [index]/[slice] stay positional and do NOT skip. Chains re-broadcast
      // (=D1:D9.user.name). Array length is COUNTA/LEN's job, not `.length`.
      if (Array.isArray(b)) {
        return b.filter((v) => v !== null && v !== undefined && v !== "")
          .map((v) => (v as Record<string, unknown>)[node.key]);
      }
      return (b as Record<string, unknown>)[node.key];
    }
    case "index": {
      const b = evalNode(node.base, lookup);
      if (isCelError(b)) return b;
      if (b === null || b === undefined) return undefined;
      const k = evalNode(node.e, lookup);
      if (isCelError(k)) return k;
      // 0-based positional access on arrays/strings, negatives from the end;
      // any other base (a dict) is keyed access — A1[B1] reads a dynamic key.
      if (Array.isArray(b) || typeof b === "string") {
        const i = Math.trunc(num(k));
        return b[i < 0 ? b.length + i : i];
      }
      return (b as Record<string, unknown>)[String(k)];
    }
    case "slice": {
      const b = evalNode(node.base, lookup);
      if (isCelError(b)) return b;
      if (b === null || b === undefined) return undefined;
      if (!Array.isArray(b) && typeof b !== "string") return VALUE();
      const from = node.from ? Math.trunc(num(evalNode(node.from, lookup))) : undefined;
      const to = node.to ? Math.trunc(num(evalNode(node.to, lookup))) : undefined;
      return b.slice(from, to);
    }
    case "call": return evalCall(node, lookup);
  }
};

const scalar = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

const flatNums = (args: Node[], lookup: Lookup): number[] => {
  const out: number[] = [];
  for (const a of args) {
    if (a.t === "range") {
      const vs = a.keys ? a.keys.map(lookup) : rangeValues(a.range, lookup);
      for (const v of vs) out.push(num(v));
    }
    else {
      // a value may itself be an array (MAP/SCAN/BYROW result, or a row/range
      // bound to a LAMBDA param) — flatten it so SUM(MAP(…)) / SUM(row) work.
      const v = evalNode(a, lookup);
      if (Array.isArray(v)) for (const x of (v as unknown[]).flat(8)) out.push(num(x));
      else out.push(num(v));
    }
  }
  return out;
};

// ── Excel-error helpers ─────────────────────────────────────────────────────
// A builtin that can't produce a value RETURNS a CelError whose `trap` is
// the kernel trap code (na/div0/ref/value/num) and whose `message` is the
// Excel sentinel (#N/A, #DIV/0!, …). Returning (rather than throwing) keeps
// the trap precise — the kernel's catch site stamps every throw as
// `RuntimeError`, which would erase the Excel code. The error then
// propagates as a normal cel value: arithmetic coerces it through num()
// (→ NaN→0) and IFERROR detects it via isCelError(). The error's `at` is
// filled in by the kernel's per-cel trap if it ever does escape via throw;
// here we own a stable, location-free CelError instead.
const xlError = (trap: string, code: string): CelError =>
  ({ kind: "error", at: [], trap, message: code });
const NA    = (): CelError => xlError("na",    "#N/A");
const DIV0  = (): CelError => xlError("div0",  "#DIV/0!");
const REF   = (): CelError => xlError("ref",   "#REF!");
const VALUE = (): CelError => xlError("value", "#VALUE!");
const NUM   = (): CelError => xlError("num",   "#NUM!");

// Flatten a list of arg nodes into scalar values, expanding ranges.
const flatVals = (args: Node[], lookup: Lookup): unknown[] => {
  const out: unknown[] = [];
  for (const a of args) {
    if (a.t === "range") {
      const vs = a.keys ? a.keys.map(lookup) : rangeValues(a.range, lookup);
      for (const v of vs) out.push(v);
    } else {
      const v = evalNode(a, lookup); // flatten array results (MAP/BYROW/row param)
      if (Array.isArray(v)) for (const x of (v as unknown[]).flat(8)) out.push(x);
      else out.push(v);
    }
  }
  return out;
};

// Evaluate a single arg node to its flat value array (a range → its
// members; a scalar → a one-element list).
const argVals = (a: Node | undefined, lookup: Lookup): unknown[] => {
  if (!a) return [];
  if (a.t === "range") return a.keys ? a.keys.map(lookup) : rangeValues(a.range, lookup);
  // an array-VALUED expression (a nested MAP/FILTER/…) spreads into the value
  // stream, exactly as a range does — so MAP(FILTER(…), fn) iterates per element.
  const v = evalNode(a, lookup);
  return Array.isArray(v) ? v : [v];
};

const str = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
};
const truthy = (v: unknown): boolean => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v === null || v === undefined || v === "") return false;
  const s = String(v).toUpperCase();
  if (s === "TRUE") return true;
  if (s === "FALSE") return false;
  return num(v) !== 0;
};

// Round x to n decimal places with a chosen rounding mode.
const roundTo = (x: number, n: number, mode: "round" | "up" | "down"): number => {
  const f = Math.pow(10, n);
  const scaled = x * f;
  const r = mode === "up"   ? (scaled < 0 ? Math.floor(scaled) : Math.ceil(scaled))
          : mode === "down" ? (scaled < 0 ? Math.ceil(scaled)  : Math.floor(scaled))
          : Math.round(scaled);
  return r / f;
};

// ── criterion matcher (COUNTIF/SUMIF/AVERAGEIF) ─────────────────────────────
// A criterion is a number/boolean (equality), or a string that may carry a
// leading comparison operator (">5", "<>x", "<=0") and/or `*`/`?` wildcards
// ("*ple", "a?c"). Returns a predicate over a candidate value.
const wildcardToRegExp = (pat: string): RegExp => {
  let re = "";
  for (const ch of pat) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
};
const makePredicate = (crit: unknown): ((v: unknown) => boolean) => {
  if (typeof crit === "number" || typeof crit === "boolean") {
    return (v) => num(v) === num(crit);
  }
  let s = String(crit ?? "");
  let op = "=";
  const m = /^(<=|>=|<>|<|>|=)/.exec(s);
  if (m) { op = m[1]!; s = s.slice(m[1]!.length); }
  const asNum = Number(s);
  const numeric = s !== "" && !Number.isNaN(asNum);
  switch (op) {
    case ">":  return (v) => num(v) > asNum;
    case "<":  return (v) => num(v) < asNum;
    case ">=": return (v) => num(v) >= asNum;
    case "<=": return (v) => num(v) <= asNum;
    case "<>":
      if (numeric) return (v) => num(v) !== asNum;
      if (/[*?]/.test(s)) { const re = wildcardToRegExp(s); return (v) => !re.test(str(v)); }
      return (v) => str(v).toUpperCase() !== s.toUpperCase();
    default: // "="
      if (numeric) return (v) => num(v) === asNum;
      if (/[*?]/.test(s)) { const re = wildcardToRegExp(s); return (v) => re.test(str(v)); }
      return (v) => str(v).toUpperCase() === s.toUpperCase();
  }
};

// ── range shape (VLOOKUP/HLOOKUP/INDEX/MATCH) ───────────────────────────────
// Re-grid a range arg's flat (row-major) value list back into rows×cols.
// Direct A1:B3 literals carry their span in `range`; cross-sheet ranges
// keep the A1 span in `range` too. Named-range cels carry only `keys` with
// no A1 span — those fall back to a single column (Nx1), which is the
// common MATCH/lookup-key shape; multi-column named ranges aren't shape-
// recoverable inline in v1 (noted; consumers can pass the literal A1:B3).
interface Grid { rows: number; cols: number; values: unknown[]; }
const rangeGrid = (a: Node | undefined, lookup: Lookup): Grid | CelError => {
  if (!a || a.t !== "range") return VALUE();
  const node = a;
  const values = node.keys ? node.keys.map(lookup) : rangeValues(node.range, lookup);
  const colon = node.range.indexOf(":");
  if (colon !== -1) {
    const from = parseRef(node.range.slice(0, colon));
    const to = parseRef(node.range.slice(colon + 1));
    if (from && to) {
      const cols = Math.abs(to.col - from.col) + 1;
      const rows = Math.abs(to.row - from.row) + 1;
      if (rows * cols === values.length) return { rows, cols, values };
    }
  }
  // No recoverable A1 span (named range): treat as a single column.
  return { rows: values.length, cols: 1, values };
};
const gridAt = (g: Grid, r: number, c: number): unknown => g.values[r * g.cols + c];

// Excel match: exact (string-insensitive / numeric), used by VLOOKUP/HLOOKUP
// /MATCH with matchType 0. Returns the 0-based index in `col` or -1.
const exactIndex = (col: unknown[], key: unknown): number => {
  const numericKey = typeof key === "number" || (typeof key === "string" && key !== "" && !Number.isNaN(Number(key)));
  for (let i = 0; i < col.length; i++) {
    const v = col[i];
    if (numericKey && typeof v === "number") { if (num(v) === num(key)) return i; }
    else if (str(v).toUpperCase() === str(key).toUpperCase()) return i;
  }
  return -1;
};
// Approximate match (Excel default, ASSUMES ascending sort): the largest
// value <= key. Numeric when both sides are numbers; otherwise a
// case-insensitive string comparison (Excel approx-matches text too).
const lte = (v: unknown, key: unknown): boolean => {
  const vn = typeof v === "number", kn = typeof key === "number"
    || (typeof key === "string" && key !== "" && !Number.isNaN(Number(key)));
  if (vn && kn) return num(v) <= num(key);
  return str(v).toUpperCase() <= str(key).toUpperCase();
};
const approxIndex = (col: unknown[], key: unknown): number => {
  let best = -1;
  for (let i = 0; i < col.length; i++) {
    if (lte(col[i], key)) best = i; else break;
  }
  return best;
};

const BUILTIN_CALLS: ReadonlySet<string> = new Set([
  "SUM", "MIN", "MAX", "AVG", "AVERAGE", "IF",
  // math / rounding
  "ROUND", "ROUNDUP", "ROUNDDOWN", "ABS", "INT", "MOD", "SQRT", "POWER",
  // predicate aggregation
  "COUNT", "COUNTA", "COUNTIF", "SUMIF", "AVERAGEIF",
  // lookup / reference
  "VLOOKUP", "HLOOKUP", "INDEX", "MATCH",
  // logical
  "AND", "OR", "NOT", "IFS", "IFERROR",
  // text
  "CONCAT", "CONCATENATE", "TEXTJOIN", "LEFT", "RIGHT", "MID", "LEN",
  "TRIM", "UPPER", "LOWER",
  // date (pure, literal args only)
  "DATE",
  // variables + higher-order (lexical, in-formula — NOT cels)
  "LET", "LAMBDA", "MAP", "FILTER", "REDUCE", "SCAN", "BYROW",
]);

// One-line docs for every inline builtin — co-located with BUILTIN_CALLS so the
// =vocab()/llms.txt catalog can surface an [excel] section WITHOUT making each
// function a cel (the shipped excel-formulas-segment design keeps eval inline,
// dependency-free). Keep this in sync when adding an arm to evalCall.
export const BUILTIN_DOCS: Readonly<Record<string, string>> = {
  SUM: "(range…) sum", MIN: "(range…) minimum", MAX: "(range…) maximum",
  AVERAGE: "(range…) mean (AVG)", IF: "(cond, then, else) branch",
  ROUND: "(x, n) round to n places", ROUNDUP: "(x, n) round away from 0", ROUNDDOWN: "(x, n) round toward 0",
  ABS: "(x) absolute value", INT: "(x) floor", MOD: "(a, b) remainder",
  SQRT: "(x) square root", POWER: "(x, y) x to the power y",
  COUNT: "(range) count numbers", COUNTA: "(range) count non-empty",
  COUNTIF: "(range, crit) count matching", SUMIF: "(range, crit, [sumRange]) sum matching",
  AVERAGEIF: "(range, crit, [avgRange]) mean matching",
  VLOOKUP: "(key, range, col, [exact]) vertical lookup", HLOOKUP: "(key, range, row, [exact]) horizontal lookup",
  INDEX: "(range, row, [col]) cell at position (1-based)", MATCH: "(key, range, [type]) 1-based position",
  AND: "(…) all true", OR: "(…) any true", NOT: "(x) negate",
  IFS: "(cond, val, …) first true", IFERROR: "(value, fallback) catch errors",
  CONCAT: "(…) join (CONCATENATE)", TEXTJOIN: "(delim, ignoreEmpty, …) join with delimiter",
  LEFT: "(s, n) first n chars", RIGHT: "(s, n) last n chars", MID: "(s, start, len) substring",
  LEN: "(s) length", TRIM: "(s) collapse spaces", UPPER: "(s) uppercase", LOWER: "(s) lowercase",
  DATE: "(y, m, d) ISO date string",
  LET: "(name, value, …, calc) bind names for THIS formula, then compute calc — reuse a sub-expression without repeating it: =LET(r, A1*2, r + r*r). NAMES MUST NOT LOOK LIKE CELL REFS: s2/g1/aa3 tokenize as A1 addresses and the binding is rejected — use sq/ga/total.",
  LAMBDA: "(param, …, body) an inline function value — pass to MAP/REDUCE/etc: =LAMBDA(x, x*x)",
  MAP: "(range, fn) apply fn to each value → array: =SUM(MAP(A1:A9, LAMBDA(x, x*x)))",
  FILTER: "(range, predicate) keep values where predicate is true → array: =FILTER(A1:A9, LAMBDA(x, x > 0))",
  REDUCE: "(init, range, fn) fold: =REDUCE(0, A1:A9, LAMBDA(acc, x, acc + x))",
  SCAN: "(init, range, fn) running fold → array of each step",
  BYROW: "(range, fn) apply fn to each ROW (an array) → array: =BYROW(A1:C3, LAMBDA(row, SUM(row)))",
};

// LET/LAMBDA scope overlay. A dotted symbol whose HEAD is a bound name walks
// the remaining path into the bound value — =LET(o, A1, o.age) — because
// `o.age` lexes as ONE name token and only binding can disambiguate it from a
// namespaced cel key. Shadowing is consistent: a bound head wins over a cel.
const scopedLookup = (scope: Map<string, unknown>, lookup: Lookup): Lookup => (k) => {
  if (scope.has(k)) return scope.get(k);
  const i = k.indexOf(".");
  if (i > 0 && scope.has(k.slice(0, i))) {
    let v = scope.get(k.slice(0, i));
    for (const part of k.slice(i + 1).split(".")) {
      if (v === null || v === undefined) return undefined;
      v = (v as Record<string, unknown>)[part];
    }
    return v;
  }
  return lookup(k);
};

const evalCall = (node: { name: string; args: Node[] }, lookup: Lookup): unknown => {
  const A = node.args;
  switch (node.name.toUpperCase()) {
    case "SUM": return flatNums(A, lookup).reduce((a, b) => a + b, 0);
    case "MIN": { const xs = flatNums(A, lookup); return xs.length ? Math.min(...xs) : 0; }
    case "MAX": { const xs = flatNums(A, lookup); return xs.length ? Math.max(...xs) : 0; }
    case "AVG": case "AVERAGE": { const xs = flatNums(A, lookup); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : DIV0(); }
    case "IF": {
      const cond = evalNode(A[0]!, lookup);
      return truthy(cond) ? evalNode(A[1]!, lookup) : (A[2] ? evalNode(A[2], lookup) : false);
    }

    // ── variables + higher-order (lexical scope, inline — no cels) ────────
    // LET(name1, val1, …, calc): bind names (evaluated left-to-right, each can
    // see earlier ones) for the duration of THIS formula, then return calc.
    case "LET": {
      if (A.length < 3 || A.length % 2 === 0) return VALUE(); // need pairs + a final calc
      const scope = new Map<string, unknown>();
      const lk = scopedLookup(scope, lookup);
      for (let i = 0; i + 1 < A.length; i += 2) {
        const nameNode = A[i]!;
        if (nameNode.t !== "sym") return VALUE(); // a name must be a bare identifier
        scope.set(nameNode.name, evalNode(A[i + 1]!, lk));
      }
      return evalNode(A[A.length - 1]!, lk);
    }
    // LAMBDA(param1, …, body): a callable VALUE. Invoked (by MAP/REDUCE/… or a
    // cell that calls it) with actual values bound to the params.
    case "LAMBDA": {
      if (A.length < 1) return VALUE();
      const params = A.slice(0, -1);
      const body = A[A.length - 1]!;
      if (params.some((p) => p.t !== "sym")) return VALUE();
      const names = params.map((p) => (p as { name: string }).name);
      return ((...vals: unknown[]): unknown => {
        const scope = new Map<string, unknown>();
        names.forEach((nm, i) => scope.set(nm, vals[i]));
        return evalNode(body, scopedLookup(scope, lookup));
      }) as Fn;
    }
    case "MAP": {
      const fn = evalNode(A[1]!, lookup);
      if (typeof fn !== "function") return VALUE();
      return argVals(A[0], lookup).map((v) => (fn as Fn)(v));
    }
    case "FILTER": {
      const fn = evalNode(A[1]!, lookup);
      if (typeof fn !== "function") return VALUE();
      return argVals(A[0], lookup).filter((v) => truthy((fn as Fn)(v)));
    }
    case "REDUCE": {
      const init = evalNode(A[0]!, lookup);
      const fn = evalNode(A[2]!, lookup);
      if (typeof fn !== "function") return VALUE();
      return argVals(A[1], lookup).reduce((acc, v) => (fn as Fn)(acc, v), init);
    }
    case "SCAN": {
      const fn = evalNode(A[2]!, lookup);
      if (typeof fn !== "function") return VALUE();
      let acc = evalNode(A[0]!, lookup);
      return argVals(A[1], lookup).map((v) => (acc = (fn as Fn)(acc, v)));
    }
    case "BYROW": {
      const fn = evalNode(A[1]!, lookup);
      if (typeof fn !== "function") return VALUE();
      const g = rangeGrid(A[0], lookup);
      if (isCelError(g)) return g;
      const out: unknown[] = [];
      for (let r = 0; r < g.rows; r++) {
        const row: unknown[] = [];
        for (let c = 0; c < g.cols; c++) row.push(gridAt(g, r, c));
        out.push((fn as Fn)(row));
      }
      return out;
    }

    // ── math / rounding ──────────────────────────────────────────────────
    case "SQRT":      return Math.sqrt(num(evalNode(A[0]!, lookup)));
    case "POWER":     return Math.pow(num(evalNode(A[0]!, lookup)), num(evalNode(A[1]!, lookup)));
    case "ROUND":     return roundTo(num(evalNode(A[0]!, lookup)), A[1] ? Math.trunc(num(evalNode(A[1], lookup))) : 0, "round");
    case "ROUNDUP":   return roundTo(num(evalNode(A[0]!, lookup)), A[1] ? Math.trunc(num(evalNode(A[1], lookup))) : 0, "up");
    case "ROUNDDOWN": return roundTo(num(evalNode(A[0]!, lookup)), A[1] ? Math.trunc(num(evalNode(A[1], lookup))) : 0, "down");
    case "ABS":       return Math.abs(num(evalNode(A[0]!, lookup)));
    case "INT":       return Math.floor(num(evalNode(A[0]!, lookup)));
    case "MOD": {
      const a = num(evalNode(A[0]!, lookup)), b = num(evalNode(A[1]!, lookup));
      if (b === 0) return DIV0();
      return a - b * Math.floor(a / b); // Excel MOD takes the divisor's sign
    }

    // ── predicate aggregation ────────────────────────────────────────────
    case "COUNT":  return flatVals(A, lookup).filter((v) => typeof v === "number" || (v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v)))).length;
    case "COUNTA": return flatVals(A, lookup).filter((v) => v !== null && v !== undefined && v !== "").length;
    case "COUNTIF": {
      const range = argVals(A[0], lookup);
      const pred = makePredicate(scalar(evalNode(A[1]!, lookup)));
      return range.filter(pred).length;
    }
    case "SUMIF": {
      const range = argVals(A[0], lookup);
      const pred = makePredicate(scalar(evalNode(A[1]!, lookup)));
      const sumRange = A[2] ? argVals(A[2], lookup) : range;
      let total = 0;
      for (let i = 0; i < range.length; i++) if (pred(range[i])) total += num(sumRange[i]);
      return total;
    }
    case "AVERAGEIF": {
      const range = argVals(A[0], lookup);
      const pred = makePredicate(scalar(evalNode(A[1]!, lookup)));
      const avgRange = A[2] ? argVals(A[2], lookup) : range;
      let total = 0, count = 0;
      for (let i = 0; i < range.length; i++) if (pred(range[i])) { total += num(avgRange[i]); count++; }
      return count ? total / count : DIV0();
    }

    // ── lookup / reference (1-based at the boundary) ─────────────────────
    case "VLOOKUP": {
      const key = scalar(evalNode(A[0]!, lookup));
      const g = rangeGrid(A[1], lookup);
      if (isCelError(g)) return g;
      const colIndex = Math.trunc(num(evalNode(A[2]!, lookup))); // 1-based
      const exact = A[3] ? !truthy(evalNode(A[3], lookup)) : false; // FALSE → exact
      if (colIndex < 1 || colIndex > g.cols) return REF();
      const firstCol: unknown[] = [];
      for (let r = 0; r < g.rows; r++) firstCol.push(gridAt(g, r, 0));
      const row = exact ? exactIndex(firstCol, key) : approxIndex(firstCol, key);
      if (row < 0) return NA();
      return gridAt(g, row, colIndex - 1);
    }
    case "HLOOKUP": {
      const key = scalar(evalNode(A[0]!, lookup));
      const g = rangeGrid(A[1], lookup);
      if (isCelError(g)) return g;
      const rowIndex = Math.trunc(num(evalNode(A[2]!, lookup))); // 1-based
      const exact = A[3] ? !truthy(evalNode(A[3], lookup)) : false;
      if (rowIndex < 1 || rowIndex > g.rows) return REF();
      const firstRow: unknown[] = [];
      for (let c = 0; c < g.cols; c++) firstRow.push(gridAt(g, 0, c));
      const col = exact ? exactIndex(firstRow, key) : approxIndex(firstRow, key);
      if (col < 0) return NA();
      return gridAt(g, rowIndex - 1, col);
    }
    case "INDEX": {
      const g = rangeGrid(A[0], lookup);
      if (isCelError(g)) return g;
      const rowNum = Math.trunc(num(evalNode(A[1]!, lookup))); // 1-based
      // For a single row/col, the second index is optional.
      let r = rowNum, c = A[2] ? Math.trunc(num(evalNode(A[2], lookup))) : 1;
      if (!A[2] && g.rows === 1) { c = rowNum; r = 1; }
      if (r < 1 || r > g.rows || c < 1 || c > g.cols) return REF();
      return gridAt(g, r - 1, c - 1);
    }
    case "MATCH": {
      const key = scalar(evalNode(A[0]!, lookup));
      const col = argVals(A[1], lookup);
      const matchType = A[2] ? Math.trunc(num(evalNode(A[2], lookup))) : 1;
      let idx: number;
      if (matchType === 0) idx = exactIndex(col, key);
      else if (matchType === 1) idx = approxIndex(col, key);       // largest <= key (asc)
      else { // -1: smallest >= key (desc)
        idx = -1;
        for (let i = 0; i < col.length; i++) { if (num(col[i]) >= num(key)) idx = i; else break; }
      }
      if (idx < 0) return NA();
      return idx + 1; // 1-based
    }

    // ── logical ──────────────────────────────────────────────────────────
    case "AND": return flatVals(A, lookup).every(truthy);
    case "OR":  return flatVals(A, lookup).some(truthy);
    case "NOT": return !truthy(evalNode(A[0]!, lookup));
    case "IFS": {
      for (let i = 0; i + 1 < A.length; i += 2) {
        if (truthy(evalNode(A[i]!, lookup))) return evalNode(A[i + 1]!, lookup);
      }
      return NA(); // no condition matched
    }
    case "IFERROR": {
      try {
        const v = evalNode(A[0]!, lookup);
        if (isCelError(v)) return evalNode(A[1]!, lookup);
        return v;
      } catch {
        return evalNode(A[1]!, lookup);
      }
    }

    // ── text ─────────────────────────────────────────────────────────────
    case "CONCAT": case "CONCATENATE":
      return flatVals(A, lookup).map(str).join("");
    case "TEXTJOIN": {
      const delim = str(scalar(evalNode(A[0]!, lookup)));
      const ignoreEmpty = truthy(evalNode(A[1]!, lookup));
      const parts = flatVals(A.slice(2), lookup).map(str);
      return (ignoreEmpty ? parts.filter((p) => p !== "") : parts).join(delim);
    }
    case "LEFT": {
      const s = str(scalar(evalNode(A[0]!, lookup)));
      const n = A[1] ? Math.trunc(num(evalNode(A[1], lookup))) : 1;
      if (n < 0) return VALUE();
      return s.slice(0, n);
    }
    case "RIGHT": {
      const s = str(scalar(evalNode(A[0]!, lookup)));
      const n = A[1] ? Math.trunc(num(evalNode(A[1], lookup))) : 1;
      if (n < 0) return VALUE();
      return n === 0 ? "" : s.slice(-n);
    }
    case "MID": {
      const s = str(scalar(evalNode(A[0]!, lookup)));
      const start = Math.trunc(num(evalNode(A[1]!, lookup))); // 1-based
      const len = Math.trunc(num(evalNode(A[2]!, lookup)));
      if (start < 1 || len < 0) return VALUE();
      return s.slice(start - 1, start - 1 + len);
    }
    case "LEN":   return str(scalar(evalNode(A[0]!, lookup))).length;
    case "TRIM":  return str(scalar(evalNode(A[0]!, lookup))).replace(/\s+/g, " ").trim();
    case "UPPER": return str(scalar(evalNode(A[0]!, lookup))).toUpperCase();
    case "LOWER": return str(scalar(evalNode(A[0]!, lookup))).toLowerCase();

    // ── date (pure; literal/computed args only — NO wall clock) ──────────
    case "DATE": {
      const y = Math.trunc(num(evalNode(A[0]!, lookup)));
      const m = Math.trunc(num(evalNode(A[1]!, lookup)));
      const d = Math.trunc(num(evalNode(A[2]!, lookup)));
      // Normalize via UTC so overflow (month 13, day 0) rolls like Excel.
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (Number.isNaN(dt.getTime())) return NUM();
      const iso = dt.toISOString().slice(0, 10); // YYYY-MM-DD (NOT an Excel serial)
      return iso;
    }

    default: {
      // USER SYMBOL — the name is a cel key (named-function-cels). The
      // lookup resolves a lambda cel's callable; anything else is an
      // undefined symbol, reported cleanly.
      const fn = lookup(node.name);
      if (typeof fn !== "function") {
        throw new Error(`infix: "${node.name}" is not a function (undefined symbol)`);
      }
      return (fn as Fn)(...node.args.map((a) => evalNode(a, lookup)));
    }
  }
};

// ── public surface ────────────────────────────────────────────────────────────

const isFormula = (src: string): boolean => src.trimStart().startsWith("=");

const parseSource = (src: string, state?: State): Node => {
  const body = src.trimStart().slice(1); // drop the leading "="
  return parseToks(tokenize(body), state);
};

const literalNode = (src: string): Node => {
  const t = src.trim();
  if (t !== "" && !Number.isNaN(Number(t))) return { t: "num", v: Number(t) };
  return { t: "str", v: src };
};

/** JSON data entry — the leading char selects the language (`=` infix, `(`
 *  S-expr), and `{`/`[` selects JSON: the cell's VALUE is the parsed
 *  object/array (which dehydrates back to JSON in the 甲骨 archive for free).
 *  Returns undefined when the content isn't parseable JSON — the cell stays a
 *  plain string, exactly as before. Wrapped in {v} so a valid JSON `null` is
 *  distinguishable from "not JSON". */
export const parseJsonEntry = (src: string): { v: unknown } | undefined => {
  const t = src.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try { return { v: JSON.parse(t) }; } catch { return undefined; }
};

const collectDeps = (node: Node, acc: Set<Key>): void => {
  switch (node.t) {
    case "ref": acc.add(node.key ?? cellKey(node.ref)); break;
    case "range":
      if (node.keys) for (const k of node.keys) acc.add(k);
      else for (const addr of expandRange(node.range)) acc.add(cellKey(addr));
      break;
    case "sym": acc.add(node.name); break;
    case "un": collectDeps(node.e, acc); break;
    case "bin": collectDeps(node.l, acc); collectDeps(node.r, acc); break;
    case "obj": for (const e of node.entries) collectDeps(e.value, acc); break;
    case "list": for (const it of node.items) collectDeps(it, acc); break;
    case "member": collectDeps(node.base, acc); break;
    case "index": collectDeps(node.base, acc); collectDeps(node.e, acc); break;
    case "slice":
      collectDeps(node.base, acc);
      if (node.from) collectDeps(node.from, acc);
      if (node.to) collectDeps(node.to, acc);
      break;
    case "call": {
      const up = node.name.toUpperCase();
      // LET/LAMBDA bind names that are NOT cel refs — collect the deps of the
      // value/body expressions, then drop the locally-bound names so they don't
      // become phantom inputMap edges.
      if (up === "LET" || up === "LAMBDA") {
        const bound = new Set<Key>();
        const tmp = new Set<Key>();
        if (up === "LET") {
          for (let i = 0; i + 1 < node.args.length; i += 2) {
            const nm = node.args[i]!;
            if (nm.t === "sym") bound.add(nm.name);
            collectDeps(node.args[i + 1]!, tmp);
          }
        } else {
          for (const p of node.args.slice(0, -1)) if (p.t === "sym") bound.add(p.name);
        }
        const body = node.args[node.args.length - 1];
        if (body) collectDeps(body, tmp);
        // Drop bound names AND dotted symbols whose head is bound (o.age
        // inside LET(o, …) reads the binding, not a cel) — matches the
        // scopedLookup shadowing rule at eval.
        for (const d of tmp) {
          const head = d.includes(".") ? d.slice(0, d.indexOf(".")) : d;
          if (!bound.has(d) && !bound.has(head)) acc.add(d);
        }
        break;
      }
      if (!BUILTIN_CALLS.has(up)) acc.add(node.name);
      for (const a of node.args) collectDeps(a, acc);
      break;
    }
    default: break;
  }
};

const lookupFromInputs = (inputs: ResolvedInputs): Lookup => (key) => {
  const c = inputs[key];
  if (c === undefined || Array.isArray(c)) return undefined;
  // Head rule: lambda cels contribute their callable; FormulaCels their
  // computed value (which may itself be a function — the unnamed
  // `=JS(A1)` cell is callable through this branch).
  if (c.celType === "FormulaCel") return c.v;
  return (c as { _fn?: unknown })._fn ?? c.v;
};

// ── binder form: =JS(A1, "name" [, TRUE]) ──────────────────────────────
// Root-level call whose name (lowercased) resolves to a CompilerCel and
// whose second argument is a string literal. The cell's VALUE becomes
// the definition request; the envelope declares the defn.commit channel
// (named-function-cels design).
interface InfixBinder { kind: string; srcNode: Node; name: string; overwrite: boolean; origin?: Key; }

const binderShape = (ast: Node, state?: State): InfixBinder | undefined => {
  if (!state || ast.t !== "call" || ast.args.length < 2 || ast.args.length > 3) return undefined;
  const kind = ast.name.toLowerCase();
  if (state.cels.get(kind)?.celType !== "CompilerCel") return undefined;
  const nameArg = ast.args[1]!;
  if (nameArg.t !== "str") return undefined;
  const flag = ast.args[2];
  if (flag !== undefined && flag.t !== "bool") return undefined;
  const srcNode = ast.args[0]!;
  return {
    kind, srcNode, name: nameArg.v,
    overwrite: flag?.t === "bool" ? flag.v : false,
    origin: srcNode.t === "ref" ? (srcNode.key ?? cellKey(srcNode.ref)) : undefined,
  };
};

const binderEnvelope = (b: InfixBinder): CompiledEnvelope => {
  const request = (source: unknown) => ({
    defn: true, name: b.name, kind: b.kind, overwrite: b.overwrite,
    source: String(source ?? ""), origin: b.origin,
  });
  return {
    fn: ((record: Record<string, unknown>) => request(evalNode(b.srcNode, (k) => record[k]))) as Fn,
    buildEvaluate: (inputs: ResolvedInputs) => {
      const lookup = lookupFromInputs(inputs);
      return (): unknown => request(evalNode(b.srcNode, lookup));
    },
    channels: ["defn.commit"],
  };
};

// ── named-range resolution (coordinate-convergence step 2) ──────────────────
// A bare symbol that resolves to a RangeCel becomes a keys-bearing
// range node at COMPILE time: member keys in A1 form over the range's
// segment (`g.A1`, …) plus a dep on the RangeCel itself — redefinition
// bumps defGeneration and consumers recompile, exactly the S-expr
// parser's contract. 2-dim ranges only (the sheet surface is 2-dim);
// higher dims stay sym and read the RangeCel's struct value.
const rangeCelKeys = (state: State, name: string): string[] | undefined => {
  const cel = state.cels.get(name);
  if (cel?.celType !== "RangeCel") return undefined;
  const r = cel.v as { at?: { segment?: string; coordinates?: number[] }; shape?: number[] };
  const at = r?.at?.coordinates;
  const shape = r?.shape;
  if (!at || !shape || at.length !== 2 || shape.length !== 2) return undefined;
  const seg = r.at!.segment;
  const keys: string[] = [];
  for (let dr = 0; dr < shape[0]!; dr++) {
    for (let dc = 0; dc < shape[1]!; dc++) {
      const addr = `${indexToCol(at[1]! + dc - 1)}${at[0]! + dr}`;
      keys.push(seg ? `${seg}.${addr}` : cellKey(addr));
    }
  }
  return keys;
};

// resolveSymbols rewrites bare names against `state` BEFORE qualifyRefs:
//   1. a named-range symbol → a range node (its member keys)
//   2. segment-local-first: a bare `sym` / user-defined call name that names a
//      live `<seg>.<name>` cel is rewritten to that key, so a grid formula reads
//      its own sheet's siblings before falling back to a global name (builtins,
//      library verbs, cross-segment names). Excel sheet-scoping for names.
// LET/LAMBDA-bound names (params) are NOT scoped — they're local bindings, not
// cel refs — so `bound` tracks them down each branch.
const resolveSymbols = (
  node: Node, state: State, defs: Set<Key>, seg?: string, bound: Set<string> = new Set(),
): Node => {
  const rec = (n: Node, b: Set<string>) => resolveSymbols(n, state, defs, seg, b);
  switch (node.t) {
    case "sym": {
      if (bound.has(node.name)) return node;
      // A dotted symbol with a bound head is scope access (o.age), never a cel.
      if (node.name.includes(".") && bound.has(node.name.slice(0, node.name.indexOf(".")))) return node;
      const keys = rangeCelKeys(state, node.name);
      if (keys) { defs.add(node.name); return { t: "range", range: node.name, keys }; }
      if (seg && !node.name.includes(".") && state.cels.has(`${seg}.${node.name}`)) {
        const q = `${seg}.${node.name}`;
        defs.add(q);
        return { t: "sym", name: q };
      }
      return node;
    }
    case "un": return { ...node, e: rec(node.e, bound) };
    case "bin": return { ...node, l: rec(node.l, bound), r: rec(node.r, bound) };
    case "obj": return { ...node, entries: node.entries.map((e) => ({ key: e.key, value: rec(e.value, bound) })) };
    case "list": return { ...node, items: node.items.map((it) => rec(it, bound)) };
    case "member": return { ...node, base: rec(node.base, bound) };
    case "index": return { ...node, base: rec(node.base, bound), e: rec(node.e, bound) };
    case "slice": return {
      ...node, base: rec(node.base, bound),
      ...(node.from ? { from: rec(node.from, bound) } : {}),
      ...(node.to ? { to: rec(node.to, bound) } : {}),
    };
    case "call": {
      const up = node.name.toUpperCase();
      if (up === "LET") {
        // LET(name1, val1, …, body): val_k may reference earlier bindings only.
        const inner = new Set(bound);
        const args: Node[] = [];
        const n = node.args.length;
        for (let i = 0; i + 1 < n; i += 2) {
          const nm = node.args[i]!;
          args.push(nm, rec(node.args[i + 1]!, inner));
          if (nm.t === "sym") inner.add(nm.name);
        }
        if (n % 2 === 1) args.push(rec(node.args[n - 1]!, inner));
        return { ...node, args };
      }
      if (up === "LAMBDA") {
        const inner = new Set(bound);
        const params = node.args.slice(0, -1);
        for (const p of params) if (p.t === "sym") inner.add(p.name);
        const body = node.args[node.args.length - 1];
        return { ...node, args: [...params, ...(body ? [rec(body, inner)] : [])] };
      }
      const args = node.args.map((a) => rec(a, bound));
      if (seg && !node.name.includes(".") && !BUILTIN_CALLS.has(up)
          && state.cels.has(`${seg}.${node.name}`)) {
        return { ...node, name: `${seg}.${node.name}`, args };
      }
      return { ...node, args };
    }
    default: return node;
  }
};

// Root call whose head cel carries `metadata.genesis` → the value is a
// structure request; declare the genesis channel (mirrors the kernel
// S-expr parser and the binder form's channel wiring).
const emitsTo = (ast: Node, state?: State): Key | undefined => {
  if (!state || ast.t !== "call") return undefined;
  const md = state.cels.get(ast.name)?.metadata as { genesis?: boolean; emitsTo?: Key } | undefined;
  if (!md) return undefined;
  if (md.emitsTo) return md.emitsTo;
  return md.genesis === true ? "genesis.commit" : undefined;
};

// The consuming cel's SEGMENT, derived from its own key: a sheet cel is
// `<seg>.<ADDR>`, so strip the trailing A1 address. Returns undefined for a
// keyless or non-addressed cel (the base 元), which keeps the legacy
// cellKey() prefix — no regression for cels that have no addressed siblings.
const selfSegmentOf = (selfKey?: Key): string | undefined => {
  const m = selfKey?.match(/^(.+)\.[A-Za-z]+[0-9]+$/);
  return m ? m[1] : undefined;
};

// Qualify every BARE A1 ref/range against `seg` (the consuming cel's own
// segment) by stamping node.key / node.keys — exactly the slots evalNode and
// collectDeps already prefer over cellKey(). Cross-sheet `Seg!A1` and named
// ranges already carry an explicit key/keys and are left untouched.
const qualifyRefs = (node: Node, seg: string): Node => {
  switch (node.t) {
    case "ref":
      return node.key ? node : { ...node, key: `${seg}.${node.ref}` };
    case "range":
      return node.keys ? node : { ...node, keys: expandRange(node.range).map((a) => `${seg}.${a}`) };
    case "un": return { ...node, e: qualifyRefs(node.e, seg) };
    case "bin": return { ...node, l: qualifyRefs(node.l, seg), r: qualifyRefs(node.r, seg) };
    case "obj": return { ...node, entries: node.entries.map((e) => ({ key: e.key, value: qualifyRefs(e.value, seg) })) };
    case "list": return { ...node, items: node.items.map((it) => qualifyRefs(it, seg)) };
    case "member": return { ...node, base: qualifyRefs(node.base, seg) };
    case "index": return { ...node, base: qualifyRefs(node.base, seg), e: qualifyRefs(node.e, seg) };
    case "slice": return {
      ...node, base: qualifyRefs(node.base, seg),
      ...(node.from ? { from: qualifyRefs(node.from, seg) } : {}),
      ...(node.to ? { to: qualifyRefs(node.to, seg) } : {}),
    };
    case "call": return { ...node, args: node.args.map((a) => qualifyRefs(a, seg)) };
    default: return node;
  }
};

// ── `:=` definition form — `seg.name := RHS` mints a named cel ───────────────
// A cell whose content is `<key> := <rhs>` is a binder: firing it emits a
// defn.commit request that mints a cel keyed <key> (no leading `=` needed,
// DAX-style). The RHS picks the tier:
//   js|py|php[.fn]{ … }     → EditableLambdaCel  (compiled, structure tier)
//   bare literal 1/"x"/TRUE → ValueCel
//   anything else           → FormulaCel parser "infix"  (value tier — the
//                             value may itself be a LAMBDA, i.e. a verb)
const DEFN_RE      = /^\s*=?\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*:=\s*([\s\S]+?)\s*$/;
const DEFN_LANG_RE = /^(js|py|php)(?:\.([A-Za-z_]\w*))?\s*\{([\s\S]*)\}\s*$/;
const DEFN_NUM_RE  = /^-?(?:\d+\.?\d*|\.\d+)$/;
const DEFN_STR_RE  = /^(['"])([\s\S]*)\1$/;

/** True when a cell's source is a `:=` definition (so it compiles as a binder). */
export const isDefinitionSource = (src: string): boolean => DEFN_RE.test(src);

interface DefnFields {
  defn: true; name: string; kind: string; source: string;
  celType: string; parser?: string; v?: unknown; segment?: string; origin?: Key;
}

// `:=` canonicalizes the verb NAME (the tail after the last dot) to UPPERCASE:
// the namespace stays lowercase (native convention), the verb is UPPER (so
// `func := …` is reachable as FUNC, never func). Enforcement-by-construction —
// you cannot mint a lower-cased verb through `:=`.
const upperVerbKey = (key: string): string => {
  const i = key.lastIndexOf(".");
  return i < 0 ? key.toUpperCase() : `${key.slice(0, i)}.${key.slice(i + 1).toUpperCase()}`;
};

const buildDefnRequest = (rawKey: string, rhs: string, origin?: Key): DefnFields => {
  const key = upperVerbKey(rawKey);
  const segment = key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : undefined;
  const base = { defn: true as const, name: key, segment, origin };
  const lang = DEFN_LANG_RE.exec(rhs);
  if (lang) {
    const [, kind, func, body] = lang;
    // The runtime's last expression IS the callable; a `.func` selector appends
    // the function name so a multi-function source resolves to the right one.
    const src = func ? `${body!.trim()}\n${func}` : body!.trim();
    return { ...base, kind: kind!, source: src, celType: "EditableLambdaCel" };
  }
  const t = rhs.trim();
  if (DEFN_NUM_RE.test(t))   return { ...base, kind: "ValueCel", source: t, celType: "ValueCel", v: Number(t) };
  const sm = DEFN_STR_RE.exec(t);
  if (sm)                    return { ...base, kind: "ValueCel", source: t, celType: "ValueCel", v: sm[2] };
  const up = t.toUpperCase();
  if (up === "TRUE" || up === "FALSE") return { ...base, kind: "ValueCel", source: t, celType: "ValueCel", v: up === "TRUE" };
  const f = t.startsWith("=") ? t : `=${t}`;
  return { ...base, kind: "infix", source: f, celType: "FormulaCel", parser: "infix" };
};

const definitionEnvelope = (key: string, rhs: string, context?: CompileContext): CompiledEnvelope => {
  const req = buildDefnRequest(key, rhs, context?.selfKey);
  return {
    fn: (() => req) as Fn,
    buildEvaluate: () => (): unknown => req,
    channels: ["defn.commit"],
  };
};

/** The infix compiler — a FormulaCel parser. */
export const compileInfix = (source: string, state?: State, context?: CompileContext): CompiledLambda => {
  const def = DEFN_RE.exec(source);
  if (def && state) return definitionEnvelope(def[1]!, def[2]!, context);
  let ast = isFormula(source) ? parseSource(source, state) : literalNode(source);
  const seg = selfSegmentOf(context?.selfKey);
  if (state) ast = resolveSymbols(ast, state, new Set(), seg);
  if (seg) ast = qualifyRefs(ast, seg);
  const binder = binderShape(ast, state);
  if (binder) return binderEnvelope(binder);
  const emitChannel = emitsTo(ast, state);
  const envelope: CompiledEnvelope = {
    fn: ((record: Record<string, unknown>) => evalNode(ast, (k) => record[k])) as Fn,
    buildEvaluate: (inputs: ResolvedInputs) => {
      const lookup = lookupFromInputs(inputs);
      return (): unknown => evalNode(ast, lookup);
    },
  };
  if (emitChannel) envelope.channels = [emitChannel];
  return envelope;
};

compileInfix.extractDeps = (source: string, state?: State, context?: CompileContext): Key[] => {
  if (DEFN_RE.test(source)) return []; // a `:=` binder has inline source — no formula deps
  if (!isFormula(source)) return [];
  let ast = parseSource(source, state);
  const acc = new Set<Key>();
  const seg = selfSegmentOf(context?.selfKey);
  if (state) ast = resolveSymbols(ast, state, acc, seg); // named-range + segment-local DEFINITION edges land in acc
  if (seg) ast = qualifyRefs(ast, seg); // wire relative deps to THIS segment's siblings
  const binder = binderShape(ast, state);
  if (binder) {
    // The binder depends on its SOURCE (and the compiler cel); the NAME
    // is what it writes, not what it reads — no edge (the defn channel
    // owns the effect; same-segment, so adjacency stays sound).
    collectDeps(binder.srcNode, acc);
    acc.add(binder.kind);
    return [...acc];
  }
  collectDeps(ast, acc);
  return [...acc];
};
