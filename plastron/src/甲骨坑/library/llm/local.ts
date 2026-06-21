// local — an in-browser LLM (WebLLM + a tiny model) behind the SAME provider seam
// as claude/grok. The model runs on WebGPU; after one (big, consent-gated)
// download it works offline. This module owns the runtime: the capability probe,
// the lazy WebLLM load (module-singleton engine), and a completion. The llm
// segment's localcheck/localload/localchat verbs are thin wrappers over these.
//
// blacklist: `localload`/`localchat` are in the DANGEROUS registry (the property)
// — the ~400MB weight download is gated by the existing central machinery, like
// claude's fetch. Nothing here calls requireConsent; the property does the work.

// ── module-local type shims (the kernel tsconfig has no DOM lib) ──────────────
interface GPUAdapterLike { limits: { maxBufferSize?: number; maxStorageBufferBindingSize?: number } }
interface GPULike { requestAdapter(): Promise<GPUAdapterLike | null> }
interface NavigatorLike {
  gpu?: GPULike;
  deviceMemory?: number;
  storage?: { estimate?(): Promise<{ quota?: number; usage?: number }> };
}
interface MLCMessage { role: "system" | "user" | "assistant"; content: string }
interface MLCEngine {
  chat: { completions: { create(req: { messages: MLCMessage[]; temperature?: number; max_tokens?: number }): Promise<{ choices: { message: { content?: string } }[] }> } };
}
interface WebLLMModule {
  CreateMLCEngine(model: string, opts: { initProgressCallback?: (p: { progress?: number; text?: string }) => void; appConfig?: unknown }): Promise<MLCEngine>;
}

// The model + where its weights live. Hosted at plastron.ca so the download comes
// from us; WebLLM caches the shards (Cache API / IndexedDB) → offline after one pull.
export const MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
// WebLLM is lazy-loaded from a CDN (esm.run) on first use, like Pyodide. The
// specifier is built at runtime so no bundler statically resolves / inlines it.
const WEBLLM_URL = "https://esm.run/@mlc-ai/web-llm";
const dynImport = (u: string): Promise<unknown> => (Function("u", "return import(u)") as (u: string) => Promise<unknown>)(u);

let _engine: MLCEngine | null = null;
let _loading: Promise<MLCEngine> | null = null;
let _progress = "";

/** The last WebLLM init-progress line (e.g. "[42%] Fetching param cache…"). A
 *  plain module read; localprogress() surfaces it (poll it during a load). */
export const localProgress = (): string => _progress;
/** Is the engine already loaded (so a completion won't trigger the download)? */
export const localReady = (): boolean => _engine !== null;

export interface LocalCheck {
  webgpu: boolean;
  deviceMemory: number;     // GB (navigator.deviceMemory; 0 if unknown)
  gpuMaxBufferMB: number;   // adapter max buffer, MB (0 if no WebGPU)
  storageFreeMB: number;    // estimated free OPFS/cache quota, MB
  canRun: boolean;          // webgpu && gpu ≳ 1GB && storage ≳ 600MB
  reason: string;           // human note when !canRun (else "ok")
}

/** Probe whether this machine can run a local model — downloads NOTHING. The UI
 *  offers the "local" provider only when canRun. Off-browser → webgpu:false. */
export const localCheck = async (): Promise<LocalCheck> => {
  const nav = (globalThis as { navigator?: NavigatorLike }).navigator;
  const out: LocalCheck = { webgpu: false, deviceMemory: 0, gpuMaxBufferMB: 0, storageFreeMB: 0, canRun: false, reason: "" };
  if (!nav) { out.reason = "no navigator (not a browser)"; return out; }
  out.deviceMemory = Number(nav.deviceMemory ?? 0);
  if (nav.storage?.estimate) {
    try { const e = await nav.storage.estimate(); out.storageFreeMB = Math.floor(((e.quota ?? 0) - (e.usage ?? 0)) / (1024 * 1024)); } catch { /* ignore */ }
  }
  if (nav.gpu) {
    try {
      const ad = await nav.gpu.requestAdapter();
      if (ad) {
        out.webgpu = true;
        const lim = ad.limits ?? {};
        out.gpuMaxBufferMB = Math.floor((Number(lim.maxBufferSize ?? lim.maxStorageBufferBindingSize ?? 0)) / (1024 * 1024));
      }
    } catch { /* adapter request failed */ }
  }
  const okGpu = out.webgpu && out.gpuMaxBufferMB >= 1024;
  const okStore = out.storageFreeMB === 0 || out.storageFreeMB >= 600; // 0 = quota unknown, don't block
  out.canRun = okGpu && okStore;
  out.reason = out.canRun ? "ok"
    : !out.webgpu ? "needs WebGPU (no navigator.gpu / no adapter)"
    : !okGpu ? `GPU max buffer ${out.gpuMaxBufferMB}MB < ~1GB needed`
    : `only ${out.storageFreeMB}MB free, need ~600MB`;
  return out;
};

/** Lazy-load WebLLM + the model into the module singleton. Idempotent + dedup'd
 *  (a concurrent caller awaits the same promise). Throws on an unsupported
 *  machine or off-browser. This is the network IO the blacklist guards. */
export const ensureEngine = async (): Promise<MLCEngine> => {
  if (_engine) return _engine;
  if (_loading) return _loading;
  const chk = await localCheck();
  if (!chk.webgpu) throw new Error(`#UNSUPPORTED(${chk.reason})`);
  _loading = (async (): Promise<MLCEngine> => {
    const webllm = (await dynImport(WEBLLM_URL)) as WebLLMModule;
    _progress = "[0%] loading WebLLM…";
    const engine = await webllm.CreateMLCEngine(MODEL_ID, {
      initProgressCallback: (p) => { _progress = p.text ?? (p.progress != null ? `[${Math.round(p.progress * 100)}%]` : ""); },
    });
    _engine = engine;
    _progress = "ready";
    return engine;
  })();
  try { return await _loading; }
  catch (e) { _loading = null; throw e; }   // failed load → allow a retry
};

/** Run a completion on the local engine (loading it on first use). OpenAI-shaped,
 *  exactly parallel to claudeFn — returns the reply text. */
export const localComplete = async (prompt: string, system?: string): Promise<string> => {
  const p = String(prompt ?? "").trim();
  if (!p) return "(ask something — the reply lands here when the prompt cel has text)";
  const engine = await ensureEngine();
  const messages: MLCMessage[] = system && String(system).trim()
    ? [{ role: "system", content: String(system) }, { role: "user", content: p }]
    : [{ role: "user", content: p }];
  const r = await engine.chat.completions.create({ messages, temperature: 0.7, max_tokens: 512 });
  return r.choices?.[0]?.message?.content ?? "";
};
