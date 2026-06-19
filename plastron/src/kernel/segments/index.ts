// segments — manifest queries over the SegmentCels in state.cels plus
// teardown. flush lives here (not dehydrate) because removing a
// segment's cels is a segment-graph operation: it walks dependents via
// derived manifest order, drains channels, then re-runs 卜's precompute.
export {
  getSegmentManifest, listSegments, listSegmentNames, segmentEntries,
  setSegmentManifest, deleteSegmentManifest, hasSegment, segmentCelKeyOf,
} from "./cels.js";
export {
  findDependents,
  computeKernelClosure, kernelClosureOf, segmentMap, topologicalDependentOrder,
} from "./graph.js";
export {
  registerSegmentLoader, loadSegment, ensureSegments, isSegmentPending,
} from "./load.js";
export { assertOneDirection, specTouchesEdges } from "./edge-rule.js";
export {
  accessPolicyOf, setAccessPolicy, accessPolicyKeyOf, hasDeclaredPolicy,
  canGet, canSet, bundleSegments, ACCESS_BUNDLES_KEY,
  currentAccessor, withAccessor,
  resolveInputCel, deniedCel, isDenied, DENIED, DEFAULT_POLICY,
} from "./access.js";
export type { AccessPolicy, AccessList } from "./access.js";
export {
  resolveTrust, kernelTrust, canUse, trustAllowsReach, setTrust,
  extractNeeds, grantDelta, CAPABILITIES, FULL_TRUST, LOCKED_TRUST,
  TRUST_KERNEL_KEY, trustKeyOf,
} from "./trust.js";
export type { Trust, Capability } from "./trust.js";
export {
  DANGEROUS, isDangerous, isConsented, requireConsent, setConsent, dangerousUsage, BLACKLISTED, lockConsent, isConsentLocked, CONSENT_KEY,
} from "./consent.js";
export type { DangerCategory, DangerSpec, ConsentGrant, DangerUse } from "./consent.js";
export {
  installDormant, dormantSegmentOf, dormantView, assertNotDormant,
} from "./dormant.js";
export { flush } from "./flush.js";
export { wake, sleep, forget } from "./wake-sleep.js";
export type { SegmentSink, SleepOptions, ForgetOptions } from "./wake-sleep.js";
