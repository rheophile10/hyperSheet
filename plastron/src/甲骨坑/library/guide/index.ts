import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// guide — doc-only ValueCels: the canonical LLM/agent guide as DATA. Each
// section is one cel whose VALUE is the section's text (banner included),
// with {order, title, audience} metadata. plastron-examples/origin/llms.md
// is GENERATED from this seed (scripts/generate-llms.mjs, run by `build`),
// so an eval FAIL's fix lands here — in a metadata cel — never in a
// hand-kept md (docs/1-design/1-under-consideration/grok-chat-bots.md,
// "the eval feedback loop"). The [[VOCAB_CATALOG]] / [[OTP_DEMO]] sentinels
// in the section texts are baked downstream by origin's bundle.ts.
// ============================================================================

export const name = "guide" as const;

// No native fns — the segment is pure data; bindNativeFns with an empty
// map is the standard seed-inflation path (inflateCel per declared cel).
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>());
