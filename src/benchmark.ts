import * as fs from "fs";
import {
  ZONE_FAST_STEP,
  ZONE_FULL_STEP,
  ZONE_WINDOW,
  probeEncoding,
  detectLanguage,
  detectScripts,
  dominantScript,
  chunkStats,
  analyseZoneScan,
  runningMean,
  runningStddev,
} from "./utils";

const CONCURRENCIES = [1, 2, 8];
const WARMUP = 10;
const iconv = require("iconv-lite");

function readFileRange(fd: number, offset: number, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const buf = Buffer.alloc(size);
    fs.read(fd, buf, 0, size, offset, (err: NodeJS.ErrnoException | null, bytesRead: number) => {
      if (err) reject(err);
      else resolve(buf.slice(0, bytesRead));
    });
  });
}

interface ScanResult {
  mode: string;
  concurrency: number;
  totalReads: number;
  zonesFound: number;
  // Wall clock
  totalMs: number;
  readsPerSec: number;
  // Budget breakdown (ms totals)
  readMs: number;
  computeMs: number;
  // Budget percentages (% of wall time, may exceed 100% with concurrency)
  readPct: number;
  computePct: number;
  // Per-read stats
  meanMs: number;
  stddevMs: number;
  cv: number;
  minMs: number;
  maxMs: number;
  slowReads: number;
  // Error tracking
  errors: Record<string, number>;
}

async function benchmark(file: string, mode: "fast" | "full", concurrency: number): Promise<ScanResult> {
  const step = mode === "fast" ? ZONE_FAST_STEP : ZONE_FULL_STEP;
  const st = fs.statSync(file);
  const fd = fs.openSync(file, "r");

  // Build offsets
  const offsets: number[] = [];
  for (let pos = 0; pos < st.size; pos += step) offsets.push(pos);

  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    await readFileRange(fd, 0, ZONE_WINDOW);
  }

  // Actual scan
  const totalReadMs: number[] = [];
  const totalComputeMs: number[] = [];
  const perReadMs: number[] = [];
  const errors: Record<string, number> = {};
  const batchComputeMs: number[] = [];
  const scans: Array<{ offset: number; encoding: string; language: string; langConfidence: number; script: string; scriptPct: number; readablePct: number; isReadable: boolean } | null> = [];

  const wallStart = performance.now();

  for (let i = 0; i < offsets.length; i += concurrency) {
    const batchStart = performance.now();
    const batch = offsets.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      batch.map(async (pos) => {
        const t0 = performance.now();
        let raw: Buffer;
        try {
          raw = await readFileRange(fd, pos, ZONE_WINDOW);
        } catch (e: any) {
          const code = e.code || e.message.slice(0, 30);
          errors[code] = (errors[code] || 0) + 1;
          return null;
        }
        const tReadEnd = performance.now();
        totalReadMs.push(tReadEnd - t0);

        if (raw.length === 0) return null;

        // Compute phase (probe + lang + script + stats)
        const probe = probeEncoding(raw);
        const enc = probe.length > 0 && probe[0].badPct < 30 ? probe[0].name : "utf-8";
        const text = iconv.decode(raw, enc).toString();
        const lang = detectLanguage(text);
        const scripts = detectScripts(text);
        const script = dominantScript(scripts);
        const scriptTotal = Object.values(scripts).reduce((a: number, b: number) => a + b, 0);
        const scriptPct = scriptTotal > 0 ? Math.round((scripts[script] || 0) / scriptTotal * 100) / 100 : 0;
        const stats = chunkStats(raw, text);
        const tComputeEnd = performance.now();
        const computeElapsed = tComputeEnd - tReadEnd;
        totalComputeMs.push(computeElapsed);
        batchComputeMs.push(computeElapsed);

        return {
          offset: pos,
          encoding: enc,
          language: lang.code,
          langConfidence: lang.confidence,
          script: script || "Binary",
          scriptPct,
          readablePct: stats ? stats.printablePct : 0,
          isReadable: stats ? stats.isReadable : false,
        };
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) scans.push(r.value);
    }

    const batchEnd = performance.now();
    const batchComputeSum = batchComputeMs.reduce((a: number, b: number) => a + b, 0);
    const batchIO = batchEnd - batchStart - batchComputeSum;
    perReadMs.push(batchIO / batch.length);
    batchComputeMs.length = 0;
  }

  const wallEnd = performance.now();
  const totalWallMs = wallEnd - wallStart;

  fs.closeSync(fd);

  // Zone analysis
  const zones = analyseZoneScan(scans.filter(Boolean) as any[]);

  // Stats
  const mean = runningMean(perReadMs);
  const stddev = runningStddev(perReadMs, mean);
  const threshold = mean + 3 * stddev;
  const slowReads = perReadMs.filter((t) => t > threshold && stddev > 0).length;

  const totalReadSum = totalReadMs.reduce((a: number, b: number) => a + b, 0);
  const totalComputeSum = totalComputeMs.reduce((a: number, b: number) => a + b, 0);
  const totalWork = totalReadSum + totalComputeSum;
  const readPct = totalWork > 0 ? (totalReadSum / totalWork) * 100 : 0;
  const computePct = totalWork > 0 ? (totalComputeSum / totalWork) * 100 : 0;
  const cv = mean > 0 ? stddev / mean : 0;

  return {
    mode,
    concurrency,
    totalReads: scans.length,
    zonesFound: zones.length,
    totalMs: Math.round(totalWallMs),
    readsPerSec: totalWallMs > 0 ? (scans.length / totalWallMs) * 1000 : 0,
    readMs: Math.round(totalReadSum),
    computeMs: Math.round(totalComputeSum),
    readPct,
    computePct,
    meanMs: Math.round(mean),
    stddevMs: Math.round(stddev),
    cv,
    minMs: Math.round(Math.min(...perReadMs)),
    maxMs: Math.round(Math.max(...perReadMs)),
    slowReads,
    errors,
  };
}

function fmtMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 10) return `${ms.toFixed(2)}ms`;
  if (ms < 100) return `${ms.toFixed(1)}ms`;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error("Usage: node benchmark.js <file-path>");
    process.exit(1);
  }

  const size = fs.statSync(file).size;
  console.log(`\nLingoFile Zone Scan Benchmark`);
  console.log(`File: ${file}`);
  console.log(`Size: ${(size / (1024 * 1024)).toFixed(1)} MB`);
  console.log(`Concurrencies: ${CONCURRENCIES.join(", ")}`);
  console.log(`Step: fast=${ZONE_FAST_STEP / 1024}KB, full=${ZONE_FULL_STEP / 1024}KB`);
  console.log(`Window: ${ZONE_WINDOW / 1024}KB\n`);

  const sep = "─".repeat(150);

  console.log(sep);
  console.log("Mode   Conc  Reads   Zones    Wall   | Read%  Comp% |     R/s |    Mean     Std |     Min     Max | >3σ       CV");
  console.log(sep);

  const modes: ("fast" | "full")[] = ["fast", "full"];
  for (const mode of modes) {
    for (const conc of CONCURRENCIES) {
      try {
        const r = await benchmark(file, mode, conc);
        const budget = r.readPct.toFixed(1) + "% " + r.computePct.toFixed(1) + "%";
        const errorsStr = Object.keys(r.errors).length > 0 ? " [" + Object.entries(r.errors).map(function(e) { return e[1] + "x" + e[0]; }).join(", ") + "]" : "";
        const cvMark = r.cv > 0.5 ? " ⚠" : "";
        const line = mode.padEnd(6) +
          String(r.concurrency).padEnd(5) +
          String(r.totalReads).padStart(5) + " " +
          String(r.zonesFound).padStart(5) + " " +
          fmtMs(r.totalMs).padEnd(8) +
          " | " + budget.padEnd(12) +
          " | " + String(r.readsPerSec.toFixed(1)).padStart(7) +
          " | " + String(fmtMs(r.meanMs)).padStart(7) + " " + String(fmtMs(r.stddevMs)).padStart(7) +
          " | " + String(fmtMs(r.minMs)).padStart(7) + " " + String(fmtMs(r.maxMs)).padStart(7) +
          " | " + String(r.slowReads).padStart(5) + " " + r.cv.toFixed(3) + cvMark;
        console.log(line);
      } catch (err: any) {
        console.log(mode.padEnd(6) + String(conc).padEnd(5) + " ERROR: " + err.message);
      }
    }
  }

  console.log(sep);
  console.log("Read%  = fs.read() time as % of total work (read + compute)");
  console.log("Comp%  = probe+lang+script+stats CPU time as % of total work");
  console.log("Mean/Std = per-slot I/O time (batch wall minus compute, divided by batch size)");
  console.log(">3σ    = number of reads exceeding mean + 3*stddev (outliers, HDD seek thrashing)");
  console.log("CV     = stddev / mean (Coefficient of Variation, ⚠ = exceeds maxCv=0.5)");
}

main().catch((err: any) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
