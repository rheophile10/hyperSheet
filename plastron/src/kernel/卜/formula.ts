import type {
  Cel, CompiledLambda, FireableCel as ComputeCel, Fn, Key, RangeNode, ResolvedInputs, SExp, State,
} from "../../types/index.js";
import { parseRange, rangeToKeys, toRange } from "./space.js";

/** Guard for the formula AST's range node (types/cels/computeCels/formulaCel). */
export const isRangeNode = (e: unknown): e is RangeNode =>
  typeof e === "object" && e !== null && !Array.isArray(e) && "range" in e && "keys" in e;

// Resolve a cel as a callable HEAD: LambdaCels expose their _fn;
// everything else uses .v. Lets a formula reference any callable cel
// (LockedLambda, EditableLambda, or a ValueCel whose v is a function)
// uniformly as the head of a list. FormulaCels at head position are
// degenerate (the formula language has no anonymous-formula concept)
// but the _fn ?? v pattern would pick the formula's compiled fn —
// not a useful value either way, so this resolves the same way.
const celHeadValue = (c: Cel): unknown => (c as ComputeCel)._fn ?? c.v;

// Resolve a cel as a VALUE referenced in argument position. Mirrors
// celHeadValue except FormulaCels are read through `.v` (their
// computed result) rather than `._fn` (their compiled formula
// function). Without this distinction, `(g f)` where `f` is a
// FormulaCel passes the *formula's compiled function* to `g` instead
// of f's most recent computed value — silently wrong, since `_fn`
// always exists on a hydrated FormulaCel.
const celArgValue = (c: Cel): unknown =>
  c.celType === "FormulaCel" ? c.v : (c as ComputeCel)._fn ?? c.v;

// ============================================================================
// S-expression formula parser + compiler.
//
// Grammar (informally):
//   expr = NUMBER | SYMBOL | '(' expr* ')'
//
// A list `(head arg1 arg2 …)` is a function call: look up `inputs[head]`
// (must be callable). Arithmetic operators (+ - * /) are nothing special
// at this layer — they live as LockedLambdaCels in the "builtins"
// segment and resolve the same way everything else does. Cels can hold
// function values directly (ValueCel.v = fn) or as LambdaCel._fn; both
// resolve through celValue().
//
// Every symbol — bare (`a`) or list head (`(myFn a b)`) — is a cel
// reference. Hydrate's auto-wire pulls every such symbol into inputMap.
//
// Numbers are JS floats. Non-numeric values flowing through arithmetic
// coerce via Number() and propagate NaN honestly.
//
// The codegen path keeps a small recognition table (BUILTIN_HEADS) so it
// can inline `(+ a b)` as `(Number(a)+Number(b))` rather than emit a
// function call. The cels still ship — they're the slow-path and
// bare-symbol resolution target. Flushing the builtins segment makes
// formulas that reach them via the slow path error cleanly.
//
// compileFormula returns a CompiledEnvelope:
//   • fn            — generic Fn(inputs) entry point used by callers
//                     that pass a freshly-built inputs object
//                     (registerLambda fast path, ad-hoc invocation)
//   • buildEvaluate — closure builder consumed by precompute. Captures
//                     resolved cel refs directly and skips inputs-
//                     object construction at fire time. Two
//                     implementations chosen at module load:
//                       • new-Function codegen for max V8 inlining
//                       • AST-walk against resolved cels when CSP
//                         blocks new Function or the formula uses
//                         array-typed inputs (which the codegen path
//                         doesn't emit for)
// ============================================================================

// Codegen-only recognition set. Members get inlined as raw JS arithmetic
// by generateBody; non-members fall through to a cel-resolved fn call.
// The runtime impls live as cels in the "builtins" segment.
const BUILTIN_HEADS: ReadonlySet<string> = new Set(["+", "-", "*", "/"]);

// Tokenizer with string-literal support. Strings are double-quoted and
// support `\\`, `\"`, `\n`, `\t`, `\r` escapes. The decoded contents
// are returned as a single token with the quotes preserved (the parser
// uses the leading `"` as the marker that distinguishes a literal from
// a symbol). Whitespace, parens, and `"` are token boundaries; nothing
// else is. Bare atoms `null`, `true`, `false` get their JS-equivalent
// values at evaluate / codegen time — they collide with cel keys of
// the same name, but reserving those words is the standard cost.
const tokenize = (src: string): string[] => {
  const tokens: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "(" || c === ")") { tokens.push(c); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let s = '"';
      let closed = false;
      while (j < n) {
        const k = src[j]!;
        if (k === "\\" && j + 1 < n) {
          const e = src[j + 1]!;
          if (e === "n") s += "\n";
          else if (e === "t") s += "\t";
          else if (e === "r") s += "\r";
          else s += e;            // covers \\, \", and any other passthrough
          j += 2;
          continue;
        }
        if (k === '"') { s += '"'; j++; closed = true; break; }
        s += k;
        j++;
      }
      if (!closed) throw new Error(`Unterminated string in formula "${src}"`);
      tokens.push(s);
      i = j;
      continue;
    }
    // Bare atom — symbol, number, or reserved literal (null/true/false).
    let j = i;
    while (j < n) {
      const k = src[j]!;
      if (k === " " || k === "\t" || k === "\n" || k === "\r" ||
          k === "(" || k === ")" || k === '"') break;
      j++;
    }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
};

// Helpers for the literal-detection sigils used in SExp strings.
const isStringLit = (s: string): boolean =>
  s.length >= 2 && s.charCodeAt(0) === 34 && s.charCodeAt(s.length - 1) === 34;

// ── ranges in the AST ───────────────────────────────────────────────────────
// Two ways a RangeNode enters the tree:
//   • a bare atom that is range notation — "Seg!A1:B3", "1,1:2,2" —
//     becomes a range literal (the ":" makes it unambiguous; tokens
//     that contain ":" but don't parse, e.g. URLs, stay symbols);
//   • a symbol that resolves to a RangeCel in `state` (a NAMED range)
//     is substituted at parse time, with `source` recording the cel key
//     so extractDeps wires a dep on the definition too.
// Either way the node carries its row-major member keys, so extractDeps
// wires every member into inputMap (approach A: ranges ride the
// existing cascade as per-member edges) and evaluation assembles the
// members' VALUES into nested arrays matching range.shape —
// grid[row][col] for 2-D, deeper nesting for higher dimensions.
//
// Caveat (named ranges): members are baked at compile time. Redefining
// a RangeCel's extent does not rewire already-compiled consumers —
// recompile them (setCel with the same f) to pick up the new members.

const rangeLiteral = (t: string): RangeNode | undefined => {
  if (!t.includes(":")) return undefined;
  const range = parseRange(t);
  if (!range) return undefined;
  return { range, keys: rangeToKeys(range) };
};

const namedRange = (t: string, state?: State): RangeNode | undefined => {
  const cel = state?.cels.get(t);
  if (!cel || cel.celType !== "RangeCel") return undefined;
  const range = toRange(cel.v);
  if (!range) return undefined;
  return { range, keys: rangeToKeys(range), source: t };
};

// Assemble a range's nested value arrays (row-major, last dimension
// varies fastest) by reading each member key through `read`.
const assembleRange = (node: RangeNode, read: (key: Key) => unknown): unknown => {
  let i = 0;
  const build = (d: number): unknown => {
    if (d === node.range.shape.length) return read(node.keys[i++]!);
    const n = node.range.shape[d]!;
    const out = new Array<unknown>(n);
    for (let j = 0; j < n; j++) out[j] = build(d + 1);
    return out;
  };
  return build(0);
};

const parse = (src: string, state?: State): SExp => {
  const tokens = tokenize(src);
  if (tokens.length === 0) throw new Error(`Empty formula "${src}"`);
  let pos = 0;

  const read = (): SExp => {
    const t = tokens[pos++];
    if (t === undefined) throw new Error(`Unexpected end of formula "${src}"`);
    if (t === ")")        throw new Error(`Unexpected ')' in formula "${src}"`);
    if (t === "(") {
      const list: SExp[] = [];
      while (tokens[pos] !== ")") {
        if (pos >= tokens.length) throw new Error(`Unterminated list in formula "${src}"`);
        list.push(read());
      }
      pos++; // consume ')'
      return list;
    }
    const n = Number(t);
    if (!Number.isNaN(n)) return n;
    if (isStringLit(t)) return t;
    const lit = rangeLiteral(t);
    if (lit) return lit;
    const named = namedRange(t, state);
    if (named) return named;
    return t; // symbol
  };

  const result = read();
  if (pos < tokens.length) throw new Error(`Trailing tokens in formula "${src}"`);
  return result;
};

const evaluate = (exp: SExp, inputs: Record<string, unknown>): unknown => {
  if (typeof exp === "number") return exp;
  if (typeof exp === "string") {
    if (exp === "null")  return null;
    if (exp === "true")  return true;
    if (exp === "false") return false;
    if (isStringLit(exp)) return exp.slice(1, -1);
    return inputs[exp];
  }
  if (isRangeNode(exp)) return assembleRange(exp, (k) => inputs[k]);
  if (exp.length === 0) return null;

  const head = exp[0];
  if (typeof head !== "string") {
    throw new Error(`Cannot call non-symbol head: ${JSON.stringify(head)}`);
  }
  const args = exp.slice(1).map((a) => evaluate(a, inputs));

  const fn = inputs[head];
  if (typeof fn !== "function") {
    throw new Error(`Formula references "${head}" but it isn't a function.`);
  }
  return fn(...args);
};

/** Symbols referenced by the formula, in first-seen order. Every
 *  non-literal symbol — data refs, function refs, arithmetic operators
 *  alike — is returned for hydrate to auto-wire into inputMap. Range
 *  nodes contribute every member key (approach A: per-member edges so
 *  partial invalidation + topo ordering just work) plus, for named
 *  ranges, the RangeCel key itself (definition dep). Pass `state` so
 *  named-range symbols resolve; without it they stay plain symbols. */
export const extractDeps = (src: string, state?: State): Key[] => {
  const ast = parse(src, state);
  const seen = new Set<string>();
  const out: Key[] = [];
  const push = (k: Key): void => {
    if (seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  const visit = (e: SExp): void => {
    if (typeof e === "string") {
      if (e === "null" || e === "true" || e === "false") return;
      if (isStringLit(e)) return;
      push(e);
    } else if (isRangeNode(e)) {
      if (e.source) push(e.source);
      for (const k of e.keys) push(k);
    } else if (Array.isArray(e)) {
      for (const c of e) visit(c);
    }
  };
  visit(ast);
  return out;
};

// ── buildEvaluate plumbing ──────────────────────────────────────────────────

// CSP / eval availability is sourced from the `csp.eval-available` cel
// (see 甲骨坑/csp.ts) and threaded down through buildEvaluateFor at
// precompute time. Callers pass the boolean explicitly so this module
// stays state-agnostic and the value is queryable for tests +
// diagnostics rather than buried in a module constant.

// Walk the AST against resolved cels — same shape as `evaluate` but
// reads cel values inline rather than from a pre-built inputs record.
// Used by buildEvaluate when codegen isn't available or the formula
// uses array-typed inputs (which the codegen path doesn't emit for).
const evaluateAgainstCels = (
  exp: SExp,
  cels: ResolvedInputs,
): unknown => {
  if (typeof exp === "number") return exp;
  if (typeof exp === "string") {
    if (exp === "null")  return null;
    if (exp === "true")  return true;
    if (exp === "false") return false;
    if (isStringLit(exp)) return exp.slice(1, -1);
    const c = cels[exp];
    if (c === undefined) return undefined;
    if (Array.isArray(c)) return c.map((x) => x === undefined ? undefined : celArgValue(x));
    return celArgValue(c);
  }
  if (isRangeNode(exp)) {
    return assembleRange(exp, (k) => {
      const c = cels[k];
      return (c === undefined || Array.isArray(c)) ? undefined : celArgValue(c);
    });
  }
  if (!Array.isArray(exp) || exp.length === 0) return null;

  const head = exp[0];
  if (typeof head !== "string") {
    throw new Error(`Cannot call non-symbol head: ${JSON.stringify(head)}`);
  }
  const args = exp.slice(1).map((a) => evaluateAgainstCels(a, cels));

  const c = cels[head];
  const fn = (c !== undefined && !Array.isArray(c)) ? celHeadValue(c) : undefined;
  if (typeof fn !== "function") {
    throw new Error(`Formula references "${head}" but it isn't a function.`);
  }
  return (fn as (...a: unknown[]) => unknown)(...args);
};

// Generate a JS expression body for the AST. Each unique symbol becomes
// a closure parameter `c0`, `c1`, …; references in the expression read
// the cel's value. Function calls compile to a call on the cel's value.
// Builtins emit raw arithmetic with Number() coercion to preserve the
// interpreter's behavior on string inputs.
const generateBody = (
  ast: SExp,
): { body: string; symbols: string[] } => {
  const symbols: string[] = [];
  const symbolIndex = new Map<string, number>();
  const indexFor = (name: string): number => {
    let i = symbols.length;
    const existing = symbolIndex.get(name);
    if (existing !== undefined) return existing;
    symbolIndex.set(name, i);
    symbols.push(name);
    return i;
  };

  // Two read forms — heads vs args. Heads need the callable: LambdaCels
  // expose it via _fn, ValueCels-with-fn via v, so `_fn ?? v` resolves
  // uniformly. Args want the cel's *value*: for ValueCels and
  // FormulaCels, that's c.v. For LambdaCels passed as values, c.v is
  // null and we need c._fn. The key wrinkle is FormulaCels: they have
  // *both* a compiled _fn (the formula function) and a v (the computed
  // result). Reading a FormulaCel as an arg with `_fn ?? v` returns the
  // wrong thing — the formula function instead of its current value.
  // celArgValue() in the AST-walk path does the celType check; here we
  // inline the equivalent so the codegen path matches semantically.
  const readHeadVar = (i: number): string => `(c${i}._fn??c${i}.v)`;
  const readArgVar  = (i: number): string =>
    `(c${i}.celType==="FormulaCel"?c${i}.v:(c${i}._fn??c${i}.v))`;

  const gen = (exp: SExp): string => {
    if (typeof exp === "number") return JSON.stringify(exp);
    if (typeof exp === "string") {
      if (exp === "null")  return "null";
      if (exp === "true")  return "true";
      if (exp === "false") return "false";
      // Re-encode through JSON.stringify so embedded newlines / quotes
      // produce valid JS source rather than raw control characters.
      if (isStringLit(exp)) return JSON.stringify(exp.slice(1, -1));
      return readArgVar(indexFor(exp));
    }
    if (isRangeNode(exp)) {
      // Emit the nested array literal directly — each member is a
      // closure-captured cel read, so the codegen path stays inlined.
      let i = 0;
      const build = (d: number): string => {
        if (d === exp.range.shape.length) return readArgVar(indexFor(exp.keys[i++]!));
        const parts: string[] = [];
        for (let j = 0; j < exp.range.shape[d]!; j++) parts.push(build(d + 1));
        return `[${parts.join(",")}]`;
      };
      return build(0);
    }
    if (!Array.isArray(exp) || exp.length === 0) return "null";

    const head = exp[0];
    if (typeof head !== "string") {
      throw new Error(`Cannot call non-symbol head: ${JSON.stringify(head)}`);
    }
    const args = exp.slice(1).map(gen);

    // Inline arithmetic operators as raw JS. Cels still need to be in
    // inputMap (extractDeps wires them) for dep tracking — the cel
    // resolution just isn't on the hot path for these heads.
    if (BUILTIN_HEADS.has(head)) {
      if (head === "+") {
        if (args.length === 0) return "0";
        return `(${args.map((a) => `Number(${a})`).join("+")})`;
      }
      if (head === "*") {
        if (args.length === 0) return "1";
        return `(${args.map((a) => `Number(${a})`).join("*")})`;
      }
      if (head === "-") {
        if (args.length === 0) return "0";
        if (args.length === 1) return `(-Number(${args[0]}))`;
        return `(${args.map((a) => `Number(${a})`).join("-")})`;
      }
      if (head === "/") {
        if (args.length === 0) return "NaN";
        if (args.length === 1) return `(1/Number(${args[0]}))`;
        return `(${args.map((a) => `Number(${a})`).join("/")})`;
      }
    }
    return `${readHeadVar(indexFor(head))}(${args.join(",")})`;
  };

  return { body: gen(ast), symbols };
};

const hasArrayInput = (cels: ResolvedInputs, symbols: string[]): boolean => {
  for (const name of symbols) {
    if (Array.isArray(cels[name])) return true;
  }
  return false;
};

// Past this many distinct scalar refs, codegen inlines too large a body/param
// list for `new Function` (OOM at ~10⁵); the AST-walk interpreter handles it
// without codegen. Generous — real formulas reference a handful of cels, and
// ranges arrive as a single array input (handled separately).
const MAX_CODEGEN_SYMBOLS = 2000;

const buildEvaluateFor = (
  ast: SExp,
  cels: ResolvedInputs,
  cspEvalAvailable: boolean,
): (() => unknown) => {
  if (cspEvalAvailable) {
    let body: string;
    let symbols: string[];
    try {
      ({ body, symbols } = generateBody(ast));
    } catch {
      // Codegen-side limitation (e.g. bare builtin) — fall through to
      // AST walk, which handles the same edge cases consistently.
      return () => evaluateAgainstCels(ast, cels);
    }
    // Codegen output assumes scalar inputs. If any input resolved to
    // an array, fall back to the AST walk which handles arrays correctly.
    if (hasArrayInput(cels, symbols)) {
      return () => evaluateAgainstCels(ast, cels);
    }
    // Arity cap. A formula with thousands of distinct scalar refs (e.g.
    // `(+ c0 c1 … c100000)`) would inline a giant body + that many params into
    // `new Function` — which OOMs the parser. The AST walk reduces over the
    // same nodes with no codegen, so fall back past the cap. (SUM over a RANGE
    // is one array input, handled above — this only trips on pathological
    // explicit-arg formulas, never normal sheet usage.)
    if (symbols.length > MAX_CODEGEN_SYMBOLS) {
      return () => evaluateAgainstCels(ast, cels);
    }
    const params = symbols.map((_, i) => `c${i}`);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(
      ...params,
      `"use strict"; return function evaluate() { return ${body}; };`,
    );
    const args: unknown[] = symbols.map((name) => cels[name] as Cel);
    return factory(...args) as () => unknown;
  }
  // CSP-blocked: AST walk against resolved cels.
  return () => evaluateAgainstCels(ast, cels);
};

// ── binder form: (compilerKey srcRef "name" [true]) ─────────────────────────
// A root-level call whose head resolves to a CompilerCel and whose
// second argument is a string literal is a BINDER (named-function-cels
// design): its VALUE is the definition request
//   { defn: true, name, source, kind, overwrite, origin }
// and the envelope declares the "defn.commit" channel — the defn
// segment's drain commits the actual setCel. The binder never compiles
// anything itself.
interface BinderShape { kind: string; srcExp: SExp; name: string; overwrite: boolean; origin?: Key; }

const binderShape = (ast: SExp, state?: State): BinderShape | undefined => {
  if (!state || !Array.isArray(ast) || ast.length < 3 || ast.length > 4) return undefined;
  const [head, srcExp, nameLit, flag] = ast;
  if (typeof head !== "string" || isStringLit(head)) return undefined;
  if (state.cels.get(head)?.celType !== "CompilerCel") return undefined;
  if (typeof nameLit !== "string" || !isStringLit(nameLit)) return undefined;
  if (flag !== undefined && flag !== "true" && flag !== "false") return undefined;
  return {
    kind: head,
    srcExp: srcExp as SExp,
    name: nameLit.slice(1, -1),
    overwrite: flag === "true",
    origin: typeof srcExp === "string" && !isStringLit(srcExp) ? srcExp : undefined,
  };
};

const binderEnvelope = (b: BinderShape): CompiledLambda => {
  const request = (source: unknown) => ({
    defn: true, name: b.name, kind: b.kind, overwrite: b.overwrite,
    source: String(source ?? ""), origin: b.origin,
  });
  return {
    fn: ((inputs: Record<string, unknown>) => request(evaluate(b.srcExp, inputs))) as Fn,
    buildEvaluate: (cels: ResolvedInputs) =>
      () => request(evaluateAgainstCels(b.srcExp, cels)),
    channels: ["defn.commit"],
  };
};

/** Parse a formula once; return the runtime body + buildEvaluate hook
 *  the kernel uses for the per-cel monomorphic closure path. Pass
 *  `state` to resolve named ranges (RangeCel refs) at parse time —
 *  the registry compile path (kernel-io's "f" cel) always does; bare
 *  compileFormula(src) callers (template event bindings) skip it and
 *  named-range symbols stay ordinary cel refs. */
// A root call whose head cel is marked `metadata.genesis` computes a
// STRUCTURE REQUEST as its value — declare the genesis channel so the
// drain commits it (same wiring as the defn binder; the envelope body
// is the ordinary one, only the channel declaration differs).
const emitsTo = (ast: SExp, state?: State): Key | undefined => {
  if (!state || !Array.isArray(ast) || ast.length === 0) return undefined;
  const head = ast[0];
  if (typeof head !== "string" || isStringLit(head)) return undefined;
  const md = state.cels.get(head)?.metadata as { genesis?: boolean; emitsTo?: Key } | undefined;
  if (!md) return undefined;
  if (md.emitsTo) return md.emitsTo;                  // generalized: any effect channel
  return md.genesis === true ? "genesis.commit" : undefined;
};

export const compileFormula = (src: string, state?: State): CompiledLambda => {
  const ast = parse(src, state);
  const binder = binderShape(ast, state);
  if (binder) return binderEnvelope(binder);
  const fn: Fn = (inputs: Record<string, unknown>) => evaluate(ast, inputs);
  const envelope: CompiledLambda = {
    fn,
    buildEvaluate: (cels: ResolvedInputs, cspEvalAvailable: boolean) =>
      buildEvaluateFor(ast, cels, cspEvalAvailable),
  };
  const ch = emitsTo(ast, state);
  if (ch) (envelope as { channels?: Key[] }).channels = [ch];
  return envelope;
};
