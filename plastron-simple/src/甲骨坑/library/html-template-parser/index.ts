import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import { compileHtmlTemplate, compileHtmlTemplateRef } from "./utils/template.js";
import {
  renderSpec_isChanged, stringList_isChanged, vnode_isChanged,
} from "./utils/schema-fns.js";
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
]));

// html-template-parser owns the vnode / render-spec types. Re-exported
// here so sibling segments (e.g. plastron-dom) reach them through this
// barrel rather than reaching into utils/ — the cross-segment edge rule.
export type {
  AttrValue, EventBinding, VText, VElement, VNode, RenderSpec,
} from "./utils/vnode.js";
export { text, bindingsEqual, vnodeEquals } from "./utils/vnode.js";
