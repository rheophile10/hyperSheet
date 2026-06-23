// probe — gather as much about the host's compute capability as the browser will
// expose, then decide whether a given model can run by comparing the probe against
// the model's manifest. Standalone: pure browser APIs + pure comparison logic, no
// dependency on any plastron segment. Destined for a kernel `capabilities` module;
// lives here for now so it's testable against real chromium today.
//
// IMPORTANT — what the browser will NOT tell you (privacy caps): there is no API
// for total VRAM or true RAM. navigator.deviceMemory is CAPPED at 8 (GB). WebGPU
// exposes per-buffer LIMITS + a vendor string, not total GPU memory. So a manifest
// match is a HEURISTIC GATE (filter the obviously-impossible), and the real arbiter
// is a try-load-with-fallback at runtime.

// ── shapes ───────────────────────────────────────────────────────────────────
export interface SystemProbe {
  ts: string;
  webgpu: {
    available: boolean;
    isFallback: boolean;                 // software adapter (lavapipe/swiftshader) → slow
    adapter: { vendor: string; architecture: string; device: string; description: string } | null;
    features: string[];                  // e.g. "shader-f16" (needed by q4f16 models)
    limits: Record<string, number>;      // maxBufferSize etc. — the VRAM PROXY
    maxBufferMB: number;                 // maxBufferSize / 1MB (heuristic ceiling)
    error?: string;
  };
  wasm: { supported: boolean; simd: boolean; threads: boolean; bulkMemory: boolean };
  cpu: { cores: number };                // hardwareConcurrency
  memory: { deviceMemoryGB: number };    // navigator.deviceMemory — CAPPED at 8
  storage: { quotaMB: number; usageMB: number; freeMB: number; persisted: boolean };
  network: { effectiveType: string; downlinkMbps: number; saveData: boolean } | null;
  platform: { ua: string; platform: string; mobile: boolean | null };
}

export type Runner = "webllm" | "wllama" | "transformers";
export interface ModelManifest {
  id: string; name: string; runner: Runner; format: "mlc" | "gguf" | "onnx";
  params: string; quant: string; downloadBytes: number; source: string;
  requires: {
    webgpu?: boolean; shaderF16?: boolean; minGpuBufferMB?: number;   // GPU path
    wasm?: boolean; wasmSimd?: boolean; wasmThreads?: boolean;        // CPU path
    minRAMGB?: number; minStorageMB?: number;
  };
  recommends?: { minGpuBufferMB?: number; minRAMGB?: number };
}
export interface RunVerdict { id: string; canRun: boolean; blockers: string[]; warnings: string[] }

// ── the browser probe (self-contained → safe to page.evaluate) ────────────────
export async function probeSystem(): Promise<SystemProbe> {
  const nav = navigator as Navigator & {
    deviceMemory?: number; gpu?: { requestAdapter(o?: unknown): Promise<unknown> };
    connection?: { effectiveType?: string; downlink?: number; saveData?: boolean };
    userAgentData?: { mobile?: boolean };
  };
  const out: SystemProbe = {
    ts: new Date().toISOString(),
    webgpu: { available: false, isFallback: false, adapter: null, features: [], limits: {}, maxBufferMB: 0 },
    wasm: { supported: typeof WebAssembly === "object", simd: false, threads: false, bulkMemory: false },
    cpu: { cores: nav.hardwareConcurrency || 0 },
    memory: { deviceMemoryGB: nav.deviceMemory || 0 },
    storage: { quotaMB: 0, usageMB: 0, freeMB: 0, persisted: false },
    network: null,
    platform: { ua: nav.userAgent, platform: (nav as Navigator & { platform?: string }).platform || "", mobile: nav.userAgentData?.mobile ?? null },
  };

  // WebGPU
  if (nav.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" }) as null | {
        isFallbackAdapter?: boolean; features: Iterable<string>; limits: Record<string, number>;
        info?: { vendor?: string; architecture?: string; device?: string; description?: string };
        requestAdapterInfo?: () => Promise<{ vendor?: string; architecture?: string; device?: string; description?: string }>;
      };
      if (adapter) {
        out.webgpu.available = true;
        out.webgpu.isFallback = !!adapter.isFallbackAdapter;
        out.webgpu.features = [...adapter.features];
        const L = adapter.limits || {};
        for (const k of ["maxBufferSize", "maxStorageBufferBindingSize", "maxComputeWorkgroupStorageSize",
                         "maxComputeInvocationsPerWorkgroup", "maxStorageBuffersPerShaderStage", "maxBindGroups"]) {
          if (typeof L[k] === "number") out.webgpu.limits[k] = L[k];
        }
        out.webgpu.maxBufferMB = Math.floor((L.maxBufferSize || L.maxStorageBufferBindingSize || 0) / (1024 * 1024));
        let info = adapter.info; if (!info && adapter.requestAdapterInfo) { try { info = await adapter.requestAdapterInfo(); } catch { /* */ } }
        if (info) out.webgpu.adapter = { vendor: info.vendor || "", architecture: info.architecture || "", device: info.device || "", description: info.description || "" };
      }
    } catch (e) { out.webgpu.error = String((e as { message?: unknown })?.message ?? e); }
  }

  // wasm feature detection via WebAssembly.validate (byte modules from wasm-feature-detect)
  const v = (bytes: number[]) => { try { return WebAssembly.validate(new Uint8Array(bytes)); } catch { return false; } };
  out.wasm.simd = v([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
  out.wasm.bulkMemory = v([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,3,1,0,1,10,14,1,12,0,65,0,65,0,65,0,252,10,0,0,11]);
  out.wasm.threads = typeof SharedArrayBuffer !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

  // storage
  if (nav.storage?.estimate) {
    try { const e = await nav.storage.estimate(); const q = (e.quota ?? 0) / 1048576, u = (e.usage ?? 0) / 1048576;
      out.storage.quotaMB = Math.floor(q); out.storage.usageMB = Math.floor(u); out.storage.freeMB = Math.floor(q - u); } catch { /* */ }
  }
  if (nav.storage?.persisted) { try { out.storage.persisted = await nav.storage.persisted(); } catch { /* */ } }

  // network (Save-Data + throughput matter for a multi-GB download)
  if (nav.connection) out.network = { effectiveType: nav.connection.effectiveType ?? "", downlinkMbps: nav.connection.downlink ?? 0, saveData: !!nav.connection.saveData };

  return out;
}

// ── the matcher (pure) ────────────────────────────────────────────────────────
export function canRunModel(probe: SystemProbe, m: ModelManifest): RunVerdict {
  const blockers: string[] = [], warnings: string[] = [];
  const r = m.requires;

  if (r.webgpu) {
    if (!probe.webgpu.available) blockers.push("needs WebGPU — none here");
    else {
      if (probe.webgpu.isFallback) warnings.push("WebGPU is a SOFTWARE adapter — will be very slow");
      if (r.shaderF16 && !probe.webgpu.features.includes("shader-f16")) blockers.push("needs the shader-f16 feature (this adapter lacks it)");
      if (r.minGpuBufferMB && probe.webgpu.maxBufferMB && probe.webgpu.maxBufferMB < r.minGpuBufferMB)
        blockers.push(`GPU max-buffer ${probe.webgpu.maxBufferMB}MB < ${r.minGpuBufferMB}MB hint`);
    }
  }
  if (r.wasm && !probe.wasm.supported) blockers.push("needs WebAssembly");
  if (r.wasmSimd && !probe.wasm.simd) blockers.push("needs wasm SIMD");
  if (r.wasmThreads && !probe.wasm.threads) warnings.push("wants wasm threads (no cross-origin isolation) — runs single-threaded, slower");
  // RAM is capped at 8 by the browser, so only flag when the (capped) value is already too low.
  if (r.minRAMGB && probe.memory.deviceMemoryGB && probe.memory.deviceMemoryGB < r.minRAMGB)
    blockers.push(`reported RAM ${probe.memory.deviceMemoryGB}GB < ${r.minRAMGB}GB (note: browser caps this at 8)`);
  const needStore = r.minStorageMB ?? Math.ceil((m.downloadBytes / 1048576) * 1.2);
  if (probe.storage.freeMB && probe.storage.freeMB < needStore)
    blockers.push(`only ${probe.storage.freeMB}MB free, need ~${needStore}MB for the weights`);
  if (probe.network?.saveData) warnings.push(`Save-Data is on — a ${(m.downloadBytes / 1048576 / 1024).toFixed(1)}GB download may be unwelcome`);
  if (m.recommends?.minGpuBufferMB && probe.webgpu.maxBufferMB && probe.webgpu.maxBufferMB < m.recommends.minGpuBufferMB)
    warnings.push(`below the recommended ${m.recommends.minGpuBufferMB}MB GPU buffer — may be tight`);

  return { id: m.id, canRun: blockers.length === 0, blockers, warnings };
}

// ── sample manifests (the kind that would live at a model registry URL) ───────
export const SAMPLE_MANIFESTS: ModelManifest[] = [
  { id: "qwen2.5-0.5b-webllm", name: "Qwen2.5 0.5B (WebLLM)", runner: "webllm", format: "mlc", params: "0.5B", quant: "q4f16_1",
    downloadBytes: 420 * 1048576, source: "https://plastron.ca/models/qwen2.5-0.5b/",
    requires: { webgpu: true, shaderF16: true, minGpuBufferMB: 256, minStorageMB: 600 } },
  { id: "qwen2.5-1.5b-gguf", name: "Qwen2.5 1.5B (wllama / CPU)", runner: "wllama", format: "gguf", params: "1.5B", quant: "Q4_K_M",
    downloadBytes: 1100 * 1048576, source: "https://huggingface.co/.../qwen2.5-1.5b-instruct-q4_k_m.gguf",
    requires: { wasm: true, wasmSimd: true, minStorageMB: 1400 }, recommends: { minRAMGB: 8 } },
  { id: "smollm2-360m-onnx", name: "SmolLM2 360M (transformers.js)", runner: "transformers", format: "onnx", params: "0.36B", quant: "q4",
    downloadBytes: 300 * 1048576, source: "https://huggingface.co/onnx-community/SmolLM2-360M-Instruct",
    requires: { wasm: true }, recommends: { minGpuBufferMB: 256 } },
  { id: "llama3.1-8b-webllm", name: "Llama 3.1 8B (WebLLM)", runner: "webllm", format: "mlc", params: "8B", quant: "q4f16_1",
    downloadBytes: 4900 * 1048576, source: "https://plastron.ca/models/llama3.1-8b/",
    requires: { webgpu: true, shaderF16: true, minGpuBufferMB: 1024, minStorageMB: 6000 }, recommends: { minGpuBufferMB: 2048 } },
];
