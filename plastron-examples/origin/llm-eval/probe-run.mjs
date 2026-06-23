// probe-run — run probeSystem() in real chromium and show what THIS machine's
// browser exposes, then gate each sample model manifest against it.
//   bun probe-run.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeSystem, canRunModel, SAMPLE_MANIFESTS } from "./probe.ts";

// storage.estimate() only works on a REAL (non-opaque) origin, so serve a blank
// page over http rather than probing about:blank.
const dir = mkdtempSync(join(tmpdir(), "probe-"));
writeFileSync(join(dir, "index.html"), "<!doctype html><title>probe</title>");
const PORT = 8801;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dir], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-webgpu",
         "--enable-features=Vulkan,WebGPU", "--use-angle=vulkan", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/`);

const probe = await page.evaluate(probeSystem);
console.log("=== SystemProbe (what the browser exposes) ===");
console.log(JSON.stringify(probe, null, 2));

console.log("\n=== can-run gating vs sample manifests ===");
for (const m of SAMPLE_MANIFESTS) {
  const v = canRunModel(probe, m);
  console.log(`${v.canRun ? "✅ CAN RUN " : "❌ blocked "} ${m.name}  (${(m.downloadBytes / 1048576 / 1024).toFixed(1)} GB, ${m.runner})`);
  for (const b of v.blockers) console.log(`      ✗ ${b}`);
  for (const w of v.warnings) console.log(`      ⚠ ${w}`);
}

await browser.close(); srv.kill();
