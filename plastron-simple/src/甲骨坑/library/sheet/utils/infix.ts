import type { CompiledEnvelope, CompiledLambda, Fn, Key, ResolvedInputs, State } from "../../../../types/index.js";
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
// function args), numbers, "strings", and the functions SUM / MIN / MAX /
// AVG / IF. Functions are evaluated inline (not cel calls), so the only
// dependencies are cell references.
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
    if (c === '"') {
      let j = i + 1, s = "";
      while (j < n && src[j] !== '"') { s += src[j]; j++; }
      toks.push({ k: "str", v: s });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.has(two)) { toks.push({ k: "op", v: two }); i += 2; continue; }
    if ("+-*/&=<>(),:!".includes(c)) { toks.push({ k: "op", v: c }); i++; continue; }
    if ((c >= "0" && c <= "9") || c === ".") {
      let j = i;
      while (j < n && ((src[j]! >= "0" && src[j]! <= "9") || src[j] === ".")) j++;
      toks.push({ k: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z")) {
      let j = i;
      while (j < n && /[A-Za-z0-9]/.test(src[j]!)) j++;
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

const parseToks = (toks: Tok[]): Node => {
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
  const concat = (): Node => {
    let l = additive();
    while (peek()?.v === "&") { next(); l = { t: "bin", op: "&", l, r: additive() }; }
    return l;
  }
  const additive = (): Node => {
    let l = multiplicative();
    for (;;) {
      const v = peek()?.v;
      if (v === "+" || v === "-") { next(); l = { t: "bin", op: v, l, r: multiplicative() }; }
      else break;
    }
    return l;
  }
  const multiplicative = (): Node => {
    let l = unary();
    for (;;) {
      const v = peek()?.v;
      if (v === "*" || v === "/") { next(); l = { t: "bin", op: v, l, r: unary() }; }
      else break;
    }
    return l;
  }
  const unary = (): Node => {
    const v = peek()?.v;
    if (v === "-" || v === "+") { next(); return { t: "un", op: v!, e: unary() }; }
    return primary();
  }
  const primary = (): Node => {
    const t = next();
    if (!t) throw new Error("infix: unexpected end");
    if (t.k === "num") return { t: "num", v: parseFloat(t.v) };
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.v === "(") { const e = comparison(); eat(")"); return e; }
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
      if (peek()?.v === "!") {
        next(); // !
        const refTok = next();
        if (!refTok || refTok.k !== "name" || !parseRef(refTok.v)) {
          throw new Error(`infix: expected a cell ref after "${t.v}!"`);
        }
        const addr = refTok.v.toUpperCase();
        return { t: "ref", ref: addr, key: `${t.v}.${addr}` };
      }
      if (parseRef(t.v)) return { t: "ref", ref: t.v.toUpperCase() };
      // Bare symbol — a cel reference by exact key (named ranges resolve
      // at compile via resolveSymbols; anything else reads the cel's v).
      return { t: "sym", name: t.v };
    }
    throw new Error(`infix: unexpected token "${t.v}"`);
  }
  // An argument may be a range (A1:B2 / Seg!A1:B3) or an expression.
  const argument = (): Node => {
    const t = peek();
    // Seg!A1:B3 — lookahead: name ! name : name
    if (t?.k === "name" && !parseRef(t.v) && toks[pos + 1]?.v === "!"
        && toks[pos + 2]?.k === "name" && parseRef(toks[pos + 2]!.v)
        && toks[pos + 3]?.v === ":" && toks[pos + 4]?.k === "name" && parseRef(toks[pos + 4]!.v)) {
      const seg = next()!.v; next(); // seg !
      const from = next()!.v.toUpperCase(); next(); // from :
      const to = next()!.v.toUpperCase();
      const keys = expandRange(`${from}:${to}`).map((addr) => `${seg}.${addr}`);
      return { t: "range", range: `${from}:${to}`, keys };
    }
    if (t?.k === "name" && parseRef(t.v) && toks[pos + 1]?.v === ":") {
      const from = next()!.v;
      eat(":");
      const to = next();
      if (!to || !parseRef(to.v)) throw new Error("infix: bad range");
      return { t: "range", range: `${from.toUpperCase()}:${to.v.toUpperCase()}` };
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
      if (op === "&") return String(scalar(evalNode(node.l, lookup))) + String(scalar(evalNode(node.r, lookup)));
      const l = evalNode(node.l, lookup);
      const r = evalNode(node.r, lookup);
      switch (op) {
        case "+": return num(l) + num(r);
        case "-": return num(l) - num(r);
        case "*": return num(l) * num(r);
        case "/": return num(l) / num(r);
        case "=": return scalar(l) === scalar(r);
        case "<>": return scalar(l) !== scalar(r);
        case "<": return num(l) < num(r);
        case ">": return num(l) > num(r);
        case "<=": return num(l) <= num(r);
        case ">=": return num(l) >= num(r);
      }
      return null;
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
    else out.push(num(evalNode(a, lookup)));
  }
  return out;
};

const BUILTIN_CALLS: ReadonlySet<string> = new Set(["SUM", "MIN", "MAX", "AVG", "AVERAGE", "IF"]);

const evalCall = (node: { name: string; args: Node[] }, lookup: Lookup): unknown => {
  switch (node.name.toUpperCase()) {
    case "SUM": return flatNums(node.args, lookup).reduce((a, b) => a + b, 0);
    case "MIN": { const xs = flatNums(node.args, lookup); return xs.length ? Math.min(...xs) : 0; }
    case "MAX": { const xs = flatNums(node.args, lookup); return xs.length ? Math.max(...xs) : 0; }
    case "AVG": case "AVERAGE": { const xs = flatNums(node.args, lookup); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
    case "IF": {
      const cond = evalNode(node.args[0]!, lookup);
      return cond ? evalNode(node.args[1]!, lookup) : (node.args[2] ? evalNode(node.args[2], lookup) : false);
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

const parseSource = (src: string): Node => {
  const body = src.trimStart().slice(1); // drop the leading "="
  return parseToks(tokenize(body));
};

const literalNode = (src: string): Node => {
  const t = src.trim();
  if (t !== "" && !Number.isNaN(Number(t))) return { t: "num", v: Number(t) };
  return { t: "str", v: src };
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
    case "call": {
      if (!BUILTIN_CALLS.has(node.name.toUpperCase())) acc.add(node.name);
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
  // `=QUICKJS(A1)` cell is callable through this branch).
  if (c.celType === "FormulaCel") return c.v;
  return (c as { _fn?: unknown })._fn ?? c.v;
};

// ── binder form: =QUICKJS(A1, "name" [, TRUE]) ──────────────────────────────
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
    origin: srcNode.t === "ref" ? cellKey(srcNode.ref) : undefined,
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

const resolveSymbols = (node: Node, state: State, defs: Set<Key>): Node => {
  switch (node.t) {
    case "sym": {
      const keys = rangeCelKeys(state, node.name);
      if (keys) { defs.add(node.name); return { t: "range", range: node.name, keys }; }
      return node;
    }
    case "un": return { ...node, e: resolveSymbols(node.e, state, defs) };
    case "bin": return { ...node, l: resolveSymbols(node.l, state, defs), r: resolveSymbols(node.r, state, defs) };
    case "call": return { ...node, args: node.args.map((a) => resolveSymbols(a, state, defs)) };
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

/** The infix compiler — a FormulaCel parser. */
export const compileInfix = (source: string, state?: State): CompiledLambda => {
  let ast = isFormula(source) ? parseSource(source) : literalNode(source);
  if (state) ast = resolveSymbols(ast, state, new Set());
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

compileInfix.extractDeps = (source: string, state?: State): Key[] => {
  if (!isFormula(source)) return [];
  let ast = parseSource(source);
  const acc = new Set<Key>();
  if (state) ast = resolveSymbols(ast, state, acc); // named-range DEFINITION edges land in acc
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
