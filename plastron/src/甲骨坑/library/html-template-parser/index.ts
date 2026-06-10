import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import { compileHtmlTemplate, compileHtmlTemplateRef } from "./utils/template.js";
import {
  renderSpec_isChanged, stringList_isChanged, vnode_isChanged,
} from "./utils/schema-fns.js";
import { bindingsEqual, vnodeEquals } from "./utils/vnode.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// html-template-parser — the view layer's two template parsers plus the
// memoSafe schemas their output flows through.
//
// Parsers ship as LockedLambdaCels (kind: native), matching every other
// compiler in the kernel (js / wat / py / the default formula "f"): a
// FormulaCel names one via metadata.parser, compileCelBody resolves it
// through resolveFn, reads its `.extractDeps` to auto-wire inputMap, and
// requires the CompiledEnvelope-with-buildEvaluate contract — which both
// template compilers satisfy. See docs/4-current/05-runCycle.
// ============================================================================

// The compiler fns carry their own extractDeps (static-method style) for
// hydrate's auto-wire pass; re-expose them as Fn with the property set.
const htmlTemplate: Fn = compileHtmlTemplate as unknown as Fn;
htmlTemplate.extractDeps = compileHtmlTemplate.extractDeps;
const htmlTemplateRef: Fn = compileHtmlTemplateRef as unknown as Fn;
htmlTemplateRef.extractDeps = compileHtmlTemplateRef.extractDeps;

export const name = "html-template-parser" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["html-template",         htmlTemplate],
  ["html-template-ref",     htmlTemplateRef],
  ["vnode_isChanged",       vnode_isChanged],
  ["render-spec_isChanged", renderSpec_isChanged],
  ["string-list_isChanged", stringList_isChanged],
  // Node-level comparators for painters: resolved once per paint drain
  // (dom), threaded into the diff — never imported.
  ["vnode.equals",         vnodeEquals as Fn],
  ["vnode.bindings-equal", bindingsEqual as Fn],
]));

// The vnode/render-spec TYPES are platform (src/types/vnode.ts).
// Comparators are reached via the vnode.equals / vnode.bindings-equal
// cels — no sibling imports from this barrel (segment-isolation D).
export { text } from "./utils/vnode.js";
