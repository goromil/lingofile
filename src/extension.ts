import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as iconv from "iconv-lite";
import {
  CHUNK_SIZE, HEX_DUMP_SIZE, SEARCH_WINDOW, SCAN_STEP, ZONE_FAST_STEP, ZONE_FULL_STEP, ZONE_WINDOW,
  chunkStats, escapeHtml, hexDump, analyseChunk, filterText, probeEncoding,
  detectLanguage, detectScripts, dominantScript, getLanguageName, formatSize,
  ChunkScan, ZoneEntry, Metafile, ZoneSummary, analyseZoneScan, fillZoneGaps, computeZoneSummary,
  ReadStats, createReadStats, runningMean, runningStddev,
} from "./utils";

const ABORT_TIMEOUT = 120000;

type ViewMode = "text" | "hex" | "raw";

interface BackendState {
  filePath: string;
  fileSize: number;
  fd: number | null;
  currentOffset: number;
  startLine: number;
  totalLinesSeen: number;
  avgLineLen: number;
  sequential: boolean;
  viewMode: ViewMode;
  skipMode: "off" | "readable" | "unreadable";
  loadSeq: number;
  scanController: AbortController | null;
  encoding: string;
  wrapEnabled: boolean;
  metafile: Metafile | null;
  readStats: ReadStats | null;
  hddrActive: boolean;
  spreadActive: boolean;
  benchCV: number | undefined;
  indicationIsSane: boolean;
}

export class LingoFilePanel {
  public static currentPanel: LingoFilePanel | undefined;
  private panel: vscode.WebviewPanel;
  private state: BackendState;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, filePath: string) {
    this.panel = panel;
    this.state = {
      filePath, fileSize: 0, fd: null,
      currentOffset: 0, startLine: 1, totalLinesSeen: 0, avgLineLen: 0,
      sequential: true, viewMode: "text", skipMode: "off",
      loadSeq: 0, scanController: null, encoding: "utf-8",
      wrapEnabled: true, metafile: null,
      readStats: null, hddrActive: false, spreadActive: false,
      benchCV: undefined, indicationIsSane: true,
    };
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.onDidChangeViewState(e => { if (e.webviewPanel.viewColumn === undefined) this.dispose(); }, null, this.disposables);
    vscode.window.onDidChangeActiveColorTheme(() => this.sendTheme(), null, this.disposables);
    vscode.commands.executeCommand("setContext", "lingofile.active", true);
    panel.webview.html = getWebviewHtml();
    panel.webview.onDidReceiveMessage(async msg => await this.handleMessage(msg), undefined, this.disposables);
    this.init();
  }

  public static render(extensionUri: vscode.Uri, filePath: string): LingoFilePanel {
    if (LingoFilePanel.currentPanel) {
      if (LingoFilePanel.currentPanel.state.filePath === filePath) {
        LingoFilePanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
        return LingoFilePanel.currentPanel;
      }
      LingoFilePanel.currentPanel.dispose();
    }
    const panel = vscode.window.createWebviewPanel("lingofile", `LingoFile: ${path.basename(filePath)}`, vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true,
    });
    return new LingoFilePanel(panel, extensionUri, filePath);
  }

  private async init(): Promise<void> {
    try {
      const st = fs.statSync(this.state.filePath);
      this.state.fileSize = st.size;
      this.state.fd = fs.openSync(this.state.filePath, "r");
      // Always display as UTF-8; probe is for stats/filtering only
      this.state.encoding = "utf-8";
      this.post("fileInfo", { name: path.basename(this.state.filePath), size: this.state.fileSize });
      this.sendTheme();
      this.post("wrap", { enabled: this.state.wrapEnabled });

      // Auto-load metafile if exists
      const metaPath = this.state.filePath + ".meta.json";
      if (fs.existsSync(metaPath)) {
        try {
          const meta: Metafile = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          if (meta.file && meta.file.size === this.state.fileSize) {
            this.state.metafile = meta;
            this.post("metaLoaded", { zones: meta.zones, summary: meta.summary });
          }
        } catch { /* ignore */ }
      }

      await this.loadChunk(0);
    } catch (err: any) {
      this.showError(`Cannot open file: ${err?.message ?? String(err)}`);
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.cmd) {
      case "loadChunk": await this.loadChunk(msg.offset); break;
      case "setViewMode": this.changeViewMode(msg.mode); break;
      case "search": await this.search(msg.query, msg.wholeFile ?? true); break;
      case "skip": await this.loadChunk(Math.max(0, Math.min(msg.offset, this.state.fileSize - 1))); break;
      case "analyse": await this.analyseAt(msg.offset ?? this.state.currentOffset); break;
      case "setSkipMode": this.state.skipMode = msg.mode; this.post("skipMode", { mode: msg.mode }); break;
      case "setWrap": this.state.wrapEnabled = msg.enabled; break;
      case "nextPage": await this.nextPage(); break;
      case "prevPage": await this.loadChunk(Math.max(0, this.state.currentOffset - CHUNK_SIZE)); break;
      case "goTop": this.state.sequential = false; await this.loadChunk(0); break;
      case "goBottom": this.state.sequential = false; await this.loadChunk(Math.max(0, this.state.fileSize - CHUNK_SIZE)); break;
      case "jumpReadable": await this.jumpToNext("readable"); break;
      case "jumpUnreadable": await this.jumpToNext("unreadable"); break;
      case "abortScan": this.cancelScan(); this.post("scanAborted"); break;
      case "theme": this.sendTheme(); break;
      case "ready": break;
      case "sliderSeek": this.state.sequential = false; await this.loadChunk(msg.offset); break;
      case "analyseZones": await this.runZoneScan("fast"); break;
      case "analyseZonesFull": await this.runZoneScan("full"); break;
      case "saveMeta": await this.saveMetafile(); break;
      case "jumpZone": this.jumpToZone(msg.zone); break;
      case "setConcurrency": {
        const v = msg.concurrency;
        if ([1, 2, 8].includes(v)) {
          vscode.workspace.getConfiguration("lingofile").update("zoneScanConcurrency", v, true);
        }
        break;
      }
    }
  }

  // ---- Chunk loading ----

  public async loadChunk(offset: number): Promise<void> {
    this.cancelScan();
    const seq = ++this.state.loadSeq;
    try {
      this.state.currentOffset = offset;
      const raw = await this.readFileRange(offset, CHUNK_SIZE);
      if (seq !== this.state.loadSeq) return;
      if (raw.length === 0) {
        this.post("chunk", { data: "[End of file]", offset, size: 0, stats: null, fileSize: this.state.fileSize, encoding: this.state.encoding, rejected: false, lines: [], startLine: this.state.startLine });
        return;
      }
      // Always decode as UTF-8 first; probe is for stats only
      const text = iconv.decode(raw, "utf-8").toString();
      const stats = chunkStats(raw, text);
      let usedEncoding = "utf-8";
      let rawText = text;
      // Only try alternate encoding if UTF-8 has >5% replacement chars
      if (stats && stats.replacedPct > 5) {
        const best = stats.bestEncoding;
        if (best && best !== "utf-8") {
          try {
            const altText = iconv.decode(raw, best).toString();
            if ((altText.match(/\ufffd/g) || []).length < raw.length * 0.05) {
              usedEncoding = best;
              rawText = altText;
            }
          } catch { /* encoding not supported */ }
        }
      }
      const isReadable = stats ? stats.isReadable : true;
      const lines = rawText.split("\n");
      if (!rawText.endsWith("\n")) lines.pop();
      if (this.state.sequential && offset > 0) {
        this.state.startLine = this.state.totalLinesSeen + 1;
      } else if (offset === 0) {
        this.state.startLine = 1;
        this.state.totalLinesSeen = 0;
      } else {
        this.state.startLine = this.state.avgLineLen > 0 ? Math.floor(offset / this.state.avgLineLen) + 1 : 1;
      }
      this.state.totalLinesSeen = this.state.startLine + lines.length - 1;
      if (this.state.avgLineLen === 0 && lines.length > 0) {
        this.state.avgLineLen = Math.max(10, rawText.length / lines.length);
      }
      this.state.sequential = false;
      const escapedLines = lines.map(l => escapeHtml(l));
      this.post("chunk", {
        data: escapedLines.join("\n"), offset, size: raw.length, stats,
        fileSize: this.state.fileSize, encoding: usedEncoding,
        rejected: !isReadable, lines: escapedLines, startLine: this.state.startLine,
        decodedEncoding: usedEncoding !== this.state.encoding ? usedEncoding : null,
        ...(this.state.viewMode === "raw" ? { rawText } : {}),
      });
      if (this.state.viewMode === "hex") await this.hexDump(offset);
    } catch (err: any) {
      if (seq === this.state.loadSeq) {
        this.post("status", { text: `Error: ${err?.message ?? String(err)}` });
        vscode.window.showErrorMessage(`LingoFile: read error at offset ${offset}`);
      }
    }
  }

  private async hexDump(offset: number): Promise<void> {
    try {
      const raw = await this.readFileRange(offset, HEX_DUMP_SIZE);
      const lines = hexDump(raw, offset);
      this.post("hex", { data: lines.join("\n"), offset, size: raw.length, fileSize: this.state.fileSize });
    } catch (err: any) {
      vscode.window.showErrorMessage(`LingoFile: hex error at ${offset}`);
    }
  }

  // ---- Search ----

  private async search(query: string, _wholeFile: boolean): Promise<void> {
    if (!query || this.state.fd === null) return;
    this.cancelScan();
    const controller = new AbortController();
    this.state.scanController = controller;
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const matches: number[] = [];
      const q = query.toLowerCase();
      const qLen = q.length;
      let lastQByteLen = 0;
      let pos = 0;
      let lastProgress = 0;
      while (pos < this.state.fileSize && matches.length < 100) {
        if (controller.signal.aborted) break;
        const readSize = Math.min(SEARCH_WINDOW, this.state.fileSize - pos);
        if (readSize <= 0) break;
        const raw = await this.readFileRange(pos, readSize);
        if (raw.length === 0) break;
        const text = iconv.decode(raw, this.state.encoding).toString().toLowerCase();
        let idx = 0;
        while ((idx = text.indexOf(q, idx)) !== -1) {
          if (matches.length >= 100) break;
          let byteOff: number;
          try { byteOff = iconv.encode(text.substring(0, idx), this.state.encoding).length; }
          catch { byteOff = idx; }
          matches.push(pos + byteOff);
          idx++;
        }
        let qByteLen: number;
        try { qByteLen = iconv.encode(q, this.state.encoding).length; }
        catch { qByteLen = qLen; }
        lastQByteLen = qByteLen;
        pos += Math.max(1, readSize - lastQByteLen);
        const progress = Math.round((pos / this.state.fileSize) * 100);
        if (progress !== lastProgress) { lastProgress = progress; this.post("searchProgress", { progress }); }
      }
      clearTimeout(timeout);
      if (!controller.signal.aborted) {
        this.post("searchResult", { matches, count: matches.length, query, scanned: pos });
      }
    } catch (err: any) {
      clearTimeout(timeout);
      this.post("status", { text: `Search error: ${err?.message ?? String(err)}` });
      vscode.window.showErrorMessage("LingoFile: search error");
    } finally { this.state.scanController = null; }
  }

  // ---- Analyse chunk ----

  public async analyseAt(offset: number) {
    try {
      const raw = await this.readFileRange(offset, 32 * 1024);
      if (raw.length === 0) { this.post("analyseError", { error: "EOF" }); return; }
      const text = iconv.decode(raw, this.state.encoding).toString();
      const filtered = filterText(text);
      const analysis = analyseChunk(raw, offset);
      this.post("analyse", { data: { ...analysis, filteredPreview: filtered.slice(0, 500), filterApplied: "control chars stripped, whitespace collapsed, HTML unescaped" } });
    } catch (err: any) {
      this.post("analyseError", { error: err?.message ?? String(err) });
    }
  }

  // ---- Zone analysis ----

   public async runZoneScan(mode: "fast" | "full"): Promise<void> {
    if (this.state.fd === null) return;
    this.cancelScan();
    this.clearHddr();
    this.state.readStats = createReadStats();
    const controller = new AbortController();
    this.state.scanController = controller;
    const timeout = setTimeout(() => controller.abort(), ABORT_TIMEOUT);
    const step = mode === "fast" ? ZONE_FAST_STEP : ZONE_FULL_STEP;
    const label = mode === "fast" ? "Fast zone scan" : "Full zone scan";
    const concurrency = this.getConfiguration().zoneScanConcurrency;
    let lastProgress = 0;
    const startTime = Date.now();
    const progressInterval = setInterval(() => {
      if (!controller.signal.aborted) this.post("scanProgress", { progress: lastProgress, label });
    }, 300);
    try {
      const offsets: number[] = [];
      for (let pos = 0; pos < this.state.fileSize; pos += step) {
        offsets.push(pos);
      }

      const scans: ChunkScan[] = [];
      let skipped = 0;

      for (let i = 0; i < offsets.length; i += concurrency) {
        if (controller.signal.aborted) { clearInterval(progressInterval); clearTimeout(timeout); return; }

        const batch = offsets.slice(i, i + concurrency);
        const results = await Promise.allSettled(batch.map(async (pos) => {
          if (controller.signal.aborted) return null;
          try {
            const raw = await this.readFileRange(pos, ZONE_WINDOW);
            if (raw.length === 0) return null;
            // Minimal analysis: only script detection, no language, no full probe
            const text = iconv.decode(raw, "utf-8").toString();
            const scripts = detectScripts(text);
            const script = dominantScript(scripts);
            const scriptTotal = Object.values(scripts).reduce((a, b) => a + b, 0);
            const scriptPct = scriptTotal > 0 ? Math.round((scripts[script] || 0) / scriptTotal * 100) / 100 : 0;
            // Quick readability check (no heavy probe)
            const replaced = (text.match(/\ufffd/g) || []).length;
            const readablePct = Math.round(((raw.length - replaced) / raw.length) * 100);
            const isReadable = replaced / raw.length < 0.5;
            return {
              offset: pos,
              encoding: "utf-8",
              language: "und",
              langConfidence: 0,
              script: script || "Binary",
              scriptPct,
              readablePct,
              isReadable,
            } as ChunkScan;
          } catch (err: any) {
            vscode.window.showWarningMessage(`Zone scan: skipped chunk at ${formatSize(pos)} — ${err?.message ?? "analysis error"}`);
            skipped++;
            return null;
          }
        }));
        for (const r of results) {
          if (r.status === "fulfilled" && r.value) scans.push(r.value);
        }

        lastProgress = Math.min(100, Math.round(((i + batch.length) / offsets.length) * 100));
      }
      clearInterval(progressInterval);
      clearTimeout(timeout);
      if (controller.signal.aborted) return;
      let zones = analyseZoneScan(scans, step);
      // Fill gaps between zones so the map covers the entire file
      zones = fillZoneGaps(zones, this.state.fileSize);
      // Post-processing: detect language per zone (lightweight, 128 words max, parallel)
      // Skip zones matching excludeScripts — no point running franc-min on them
      const excludeScripts = this.getConfiguration().excludeScripts;
      let langSkipped = 0;
      const langConcurrency = 4;
      for (let zi = 0; zi < zones.length; zi += langConcurrency) {
        if (controller.signal.aborted) { clearInterval(progressInterval); clearTimeout(timeout); return; }
        const batch = zones.slice(zi, zi + langConcurrency);
        await Promise.allSettled(batch.map(async (z) => {
          if (z.script === "Gap") {
            return;
          }
          if (excludeScripts.includes(z.script)) {
            z.label = `Skipped (${z.script})`;
            langSkipped++;
            return;
          }
          try {
            const sample = await this.readFileRange(z.offset, 8 * 1024);
            if (sample.length === 0) return;
            const text = iconv.decode(sample, "utf-8").toString();
            const lang = detectLanguage(text, 128);
            z.language = lang.code;
            z.languageConfidence = lang.confidence;
            z.label = lang.code !== "und" ? `${getLanguageName(lang.code)} (${lang.confidence.toFixed(1)})` : z.script;
          } catch { /* skip this zone */ }
        }));
        this.post("zoneLangUpdate", { zones, count: Math.min(zi + langConcurrency, zones.length), total: zones.length });
      }
      const summary = computeZoneSummary(zones, this.state.fileSize);
      summary.scanDuration = Date.now() - startTime;
      const metaProbe = probeEncoding(await this.readFileRange(0, 64));
      this.state.metafile = {
        version: "1.0",
        tool: `lingofile@0.2.9`,
        created: new Date().toISOString(),
        file: { name: path.basename(this.state.filePath), size: this.state.fileSize, mtime: fs.statSync(this.state.filePath).mtimeMs },
        encoding: { primary: this.state.encoding, probe: metaProbe.slice(0, 4).map(e => ({ name: e.name, badPct: e.badPct })) },
        zones,
        summary,
      };
      this.post("zonesDone", { zones, summary, mode });
      this.reportReadErrors(label);
      this.clearHddr();
      const skipMsg = skipped > 0 ? ` (${skipped} chunks skipped)` : "";
      const langSkipMsg = langSkipped > 0 ? ` (${langSkipped} lang skipped)` : "";
      vscode.window.showInformationMessage(`${label} complete: ${zones.length} zones found (${formatSize(this.state.fileSize)})${skipMsg}${langSkipMsg}.`);
    } catch (err: any) {
      clearInterval(progressInterval);
      clearTimeout(timeout);
      this.reportReadErrors(label);
      this.clearHddr();
      vscode.window.showErrorMessage(`LingoFile: ${label} error: ${err?.message ?? String(err)}`);
    } finally { this.state.scanController = null; }
  }

  private reportReadErrors(label: string): void {
    if (!this.state.readStats) return;
    const errors = this.state.readStats.errors;
    const keys = Object.keys(errors);
    if (keys.length === 0) return;
    const parts = keys.map(k => `${errors[k].count}× ${k}`).join(", ");
    const slow = this.state.readStats.slowReads > 0 ? `, ${this.state.readStats.slowReads} slow-reads` : "";
    vscode.window.showWarningMessage(`${label}: ${parts}${slow}`);
  }

  // ---- Metafile ----

  public async saveMetafile(): Promise<void> {
    if (!this.state.metafile) {
      vscode.window.showWarningMessage("No analysis data to save. Run zone analysis first.");
      return;
    }
    const metaPath = this.state.filePath + ".meta.json";
    try {
      fs.writeFileSync(metaPath, JSON.stringify(this.state.metafile, null, 2), "utf-8");
      vscode.window.showInformationMessage(`Metafile saved: ${metaPath}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Cannot save metafile: ${err?.message ?? String(err)}`);
    }
  }

  public async loadMetafilePath(): Promise<void> {
    const uri = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { Metafile: ["json"] } });
    if (!uri?.[0]) return;
    try {
      const meta: Metafile = JSON.parse(fs.readFileSync(uri[0].fsPath, "utf-8"));
      this.state.metafile = meta;
      this.post("metaLoaded", { zones: meta.zones, summary: meta.summary });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Cannot load metafile: ${err?.message ?? String(err)}`);
    }
  }

  public jumpToZone(zone: ZoneEntry): void {
    this.state.sequential = false;
    this.loadChunk(zone.offset);
  }

  public get metafile(): Metafile | null {
    return this.state.metafile;
  }

  // ---- Navigation ----

  public async nextPage(): Promise<void> {
    let off = this.state.currentOffset + CHUNK_SIZE;
    if (off >= this.state.fileSize) { vscode.window.showWarningMessage("LingoFile: At end of file"); return; }
    if (this.state.skipMode !== "off") {
      const res = await this.scanForMode(off, this.state.skipMode);
      if (res.cancelled) { this.post("scanAborted"); return; }
      if (!res.found) { vscode.window.showWarningMessage(`LingoFile: No ${this.state.skipMode} content found`); return; }
      off = res.offset;
    }
    this.state.sequential = true;
    await this.loadChunk(off);
  }

  private async jumpToNext(mode: "readable" | "unreadable"): Promise<void> {
    const from = this.state.currentOffset + CHUNK_SIZE;
    if (from >= this.state.fileSize) { vscode.window.showWarningMessage("LingoFile: At end of file"); return; }
    const res = await this.scanForMode(from, mode);
    if (res.cancelled) { this.post("scanAborted"); return; }
    if (!res.found) { vscode.window.showWarningMessage(`LingoFile: No ${mode} content found`); return; }
    this.state.sequential = false;
    await this.loadChunk(res.offset);
  }

  private async scanForMode(fromOffset: number, mode: "readable" | "unreadable"): Promise<{ found: boolean; offset: number; cancelled: boolean }> {
    this.cancelScan();
    const controller = new AbortController();
    this.state.scanController = controller;
    const timeout = setTimeout(() => controller.abort(), ABORT_TIMEOUT);
    const wantReadable = mode === "readable";
    let lastProgress = 0;
    const progressInterval = setInterval(() => { if (!controller.signal.aborted) this.post("scanProgress", { progress: lastProgress }); }, 300);
    try {
      let pos = fromOffset;
      while (pos < this.state.fileSize) {
        if (controller.signal.aborted) { clearInterval(progressInterval); clearTimeout(timeout); return { found: false, offset: pos, cancelled: true }; }
        const raw = await this.readFileRange(pos, CHUNK_SIZE);
        if (raw.length === 0) break;
        const text = iconv.decode(raw, this.state.encoding).toString();
        const stats = chunkStats(raw, text);
        const readable = stats ? stats.isReadable : true;
        lastProgress = Math.round((pos / this.state.fileSize) * 100);
        if (readable === wantReadable) { clearInterval(progressInterval); clearTimeout(timeout); return { found: true, offset: pos, cancelled: false }; }
        pos += SCAN_STEP;
      }
      clearInterval(progressInterval); clearTimeout(timeout);
      return { found: false, offset: pos, cancelled: false };
    } finally { this.state.scanController = null; }
  }

  // ---- Benchmark ----

  public async runBenchmark(): Promise<void> {
    if (this.state.fd === null) { vscode.window.showWarningMessage("No file open."); return; }
    const N = 100;
    const step = ZONE_FAST_STEP;
    const window = ZONE_WINDOW;
    const timings: number[] = [];
    const controller = new AbortController();
    this.state.scanController = controller;
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      for (let i = 0; i < N && !controller.signal.aborted; i++) {
        const off = (i * step) % this.state.fileSize;
        const t0 = performance.now();
        const raw = await this.readFileRange(off, window);
        timings.push(performance.now() - t0);
        if (raw.length === 0) break;
      }
      clearTimeout(timeout);
      if (controller.signal.aborted) return;
      if (timings.length < 10) { vscode.window.showWarningMessage("Benchmark: too few reads."); return; }
      const mean = runningMean(timings);
      const stddev = runningStddev(timings, mean);
      const cv = mean > 0 ? stddev / mean : 0;
      const threshold = mean + 3 * stddev;
      const slowReads = timings.filter(t => t > threshold && stddev > 0).length;

      // Calibrate health indicators from benchmark
      this.state.benchCV = cv;
      this.state.indicationIsSane = slowReads <= 6 * cv || cv < 0.1;

      this.state.readStats = createReadStats();
      this.state.readStats.timings = timings.slice(-100);
      this.post("benchmark", {
        mean: mean.toFixed(1), stddev: stddev.toFixed(1), cv: cv.toFixed(3),
        slowReads, total: timings.length,
        maxHealthyCV: this.maxHealthyCV.toFixed(3), sane: this.state.indicationIsSane,
      });

      const saneMsg = this.state.indicationIsSane ? "" : " ❌ indicators disabled (too many outliers)";
      vscode.window.showInformationMessage(
        `Benchmark: ${timings.length} reads | mean ${mean.toFixed(1)}ms | std ${stddev.toFixed(1)}ms | CV ${cv.toFixed(3)}${saneMsg} | >3σ ${slowReads} | maxHealthyCV=${this.maxHealthyCV.toFixed(3)}`
      );
    } finally {
      this.state.scanController = null;
    }
  }

  // ---- View mode ----

  private changeViewMode(mode: ViewMode) {
    this.state.viewMode = mode;
    this.post("viewMode", { mode });
    this.loadChunk(this.state.currentOffset);
  }

  // ---- Scan control ----

  public get currentOffset(): number { return this.state.currentOffset; }
  public get wrapEnabled(): boolean { return this.state.wrapEnabled; }
  public set wrapEnabled(v: boolean) { this.state.wrapEnabled = v; }

  public cancelScan() {
    if (this.state.scanController) { this.state.scanController.abort(); this.state.scanController = null; }
  }

  // ---- IO ----

  private readFileRange(offset: number, size: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.state.fd === null) return reject(new Error("File not open"));
      const buf = Buffer.alloc(size);
      const t0 = performance.now();
      fs.read(this.state.fd, buf, 0, size, offset, (err, bytesRead) => {
        const elapsed = performance.now() - t0;
        this.trackRead(elapsed, err, offset);
        if (err) reject(err);
        else resolve(buf.slice(0, bytesRead));
      });
    });
  }

  private trackRead(elapsed: number, err: NodeJS.ErrnoException | null, offset: number): void {
    if (!this.state.readStats) return;
    const stats = this.state.readStats;
    stats.timings.push(elapsed);
    if (stats.timings.length > 100) stats.timings.shift();
    if (err) {
      const code = err.code || err.message.slice(0, 30);
      if (!stats.errors[code]) stats.errors[code] = { count: 0, lastMs: elapsed, offset };
      stats.errors[code].count++;
      stats.errors[code].lastMs = elapsed;
      stats.errors[code].offset = offset;
    }
    if (stats.timings.length >= 10) {
      const mean = runningMean(stats.timings);
      const stddev = runningStddev(stats.timings, mean);
      const cv = mean > 0 ? stddev / mean : 0;
      const cfg = this.getConfiguration();

      if (this.state.indicationIsSane) {
        const threshold = mean + cfg.sigmaThreshold * cv * mean;
        if (elapsed > threshold && cv > 0) {
          stats.slowReads++;
          if (!this.state.hddrActive) {
            this.state.hddrActive = true;
            this.post("hddr", { slowReads: stats.slowReads, mean: +mean.toFixed(1), stddev: +stddev.toFixed(1), threshold: +threshold.toFixed(1), cv: +cv.toFixed(3) });
          }
        }
        if (cv > this.maxHealthyCV && !this.state.spreadActive) {
          this.state.spreadActive = true;
          this.post("spread", { cv: +cv.toFixed(3), mean: +mean.toFixed(1), stddev: +stddev.toFixed(1), maxHealthyCV: +this.maxHealthyCV.toFixed(3) });
        }
      }
    }
  }

  // ---- Messaging ----

  private sendTheme() {
    const kind = vscode.window.activeColorTheme.kind;
    const dark = { bg: "#1e1e1e", bg2: "#252526", bg3: "#2d2d2d", bg4: "#333333", fg: "#cccccc", fg2: "#969696", fg3: "#666666", accent: "#007acc", accent2: "#0e639c", green: "#4ec9b0", red: "#f44747", orange: "#ce9178", yellow: "#dcdcaa", blue: "#569cd6", border: "#444", statusbar: "#007acc", linehl: "#2a2d2e", gutter: "#3c3c3c", matchhl: "#ff000066" };
    const light = { bg: "#ffffff", bg2: "#f3f3f3", bg3: "#efefef", bg4: "#ececec", fg: "#333333", fg2: "#717171", fg3: "#9a9a9a", accent: "#007acc", accent2: "#005a9e", green: "#008000", red: "#c41a16", orange: "#d7ba73", yellow: "#795e26", blue: "#001080", border: "#e8e8e8", statusbar: "#007acc", linehl: "#f0f0f0", gutter: "#f5f5f5", matchhl: "#ff000022" };
    const hc = { bg: "#000000", bg2: "#000000", bg3: "#000000", bg4: "#000000", fg: "#ffffff", fg2: "#ffffff", fg3: "#ffffff", accent: "#00ffff", accent2: "#00cccc", green: "#00ff00", red: "#ff0000", orange: "#ff8c00", yellow: "#ffff00", blue: "#00ffff", border: "#ffffff", statusbar: "#00ffff", linehl: "#333333", gutter: "#000000", matchhl: "#ffffff33" };
    const palette = kind === 2 ? light : kind === 3 ? hc : dark;
    this.post("theme", { colors: palette });
  }

  public post(cmd: string, data: Record<string, any> = {}): void {
    this.panel.webview.postMessage({ cmd, ...data });
  }

  private showError(message: string): void {
    this.panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;font-family:monospace;background:#1e1e1e;color:#ccc}.err{text-align:center;font-size:14px;padding:20px}</style></head><body><div class="err">${escapeHtml(message)}</div></body></html>`;
    vscode.window.showErrorMessage(`LingoFile: ${message}`);
  }

  // ---- Dispose ----

  public dispose() {
    this.cancelScan();
    this.post("scanAborted");
    this.clearHddr();
    if (this.state.fd !== null) { try { fs.closeSync(this.state.fd); } catch { /* already closed */ } this.state.fd = null; }
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private getConfiguration(): { zoneScanConcurrency: number; sigmaThreshold: number; defaultHealthyCV: number; excludeScripts: string[] } {
    const cfg = vscode.workspace.getConfiguration("lingofile");
    return {
      zoneScanConcurrency: cfg.get<number>("zoneScanConcurrency", 2),
      sigmaThreshold: cfg.get<number>("sigmaThreshold", 3),
      defaultHealthyCV: cfg.get<number>("maxCv", 0.5),
      excludeScripts: cfg.get<string[]>("zoneScanExcludeScripts", ["Binary"]),
    };
  }

  private get healthyCV(): number {
    return this.state.benchCV !== undefined ? this.state.benchCV : this.getConfiguration().defaultHealthyCV;
  }

  private get maxHealthyCV(): number {
    return 2 * this.healthyCV;
  }

  private clearHddr(): void {
    this.state.hddrActive = false;
    this.state.spreadActive = false;
    this.state.readStats = null;
    this.state.benchCV = undefined;
    this.state.indicationIsSane = true;
    this.post("hddrClear", {});
    this.post("spreadClear", {});
  }
}

// ---- Activation ----

export function activate(context: vscode.ExtensionContext): void {
  const getPanel = () => LingoFilePanel.currentPanel;

  context.subscriptions.push(
    vscode.commands.registerCommand("lingofile.open", () => {
      vscode.window.showOpenDialog({ openLabel: "Open with LingoFile", canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { Text: ["txt", "text", "log", "csv", "json", "xml", "html", "md"], All: ["*"] } })
        .then(uris => { if (uris?.[0]) LingoFilePanel.render(context.extensionUri, uris[0].fsPath); });
    }),
    vscode.commands.registerCommand("lingofile.openActive", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc?.uri.scheme === "file" || doc?.uri.scheme === "vscode-remote") LingoFilePanel.render(context.extensionUri, doc.uri.fsPath);
      else vscode.window.showErrorMessage("No active file.");
    }),
    vscode.commands.registerCommand("lingofile.previewFile", (uri: vscode.Uri) => {
      if (uri && (uri.scheme === "file" || uri.scheme === "vscode-remote")) LingoFilePanel.render(context.extensionUri, uri.fsPath);
      else {
        const doc = vscode.window.activeTextEditor?.document;
        if (doc && (doc.uri.scheme === "file" || doc.uri.scheme === "vscode-remote")) LingoFilePanel.render(context.extensionUri, doc.uri.fsPath);
        else vscode.window.showErrorMessage("No file to preview.");
      }
    }),
    vscode.commands.registerCommand("lingofile.focusSearch", () => { getPanel()?.post("focusSearch"); }),
    vscode.commands.registerCommand("lingofile.focusOffset", () => { getPanel()?.post("focusOffset"); }),
    vscode.commands.registerCommand("lingofile.toggleWrap", () => {
      const p = getPanel();
      if (p) { p.wrapEnabled = !p.wrapEnabled; p.post("wrap", { enabled: p.wrapEnabled }); }
    }),
    vscode.commands.registerCommand("lingofile.reloadChunk", () => {
      const p = getPanel(); if (p) p.loadChunk(p.currentOffset);
    }),
    vscode.commands.registerCommand("lingofile.nextPage", () => { getPanel()?.nextPage(); }),
    vscode.commands.registerCommand("lingofile.prevPage", () => {
      const p = getPanel();
      if (p) p.loadChunk(Math.max(0, p.currentOffset - CHUNK_SIZE));
    }),
    vscode.commands.registerCommand("lingofile.abortOperation", () => {
      const p = getPanel();
      if (p) { p.cancelScan(); p.post("scanAborted"); }
    }),
    vscode.commands.registerCommand("lingofile.toggleSlider", () => { getPanel()?.post("toggleSlider"); }),
    vscode.commands.registerCommand("lingofile.analyseChunk", () => {
      const p = getPanel();
      if (p) p.analyseAt(p.currentOffset);
    }),
    vscode.commands.registerCommand("lingofile.analyseZones", () => { getPanel()?.runZoneScan("fast"); }),
    vscode.commands.registerCommand("lingofile.analyseZonesFull", () => { getPanel()?.runZoneScan("full"); }),
    vscode.commands.registerCommand("lingofile.saveMeta", () => { getPanel()?.saveMetafile(); }),
    vscode.commands.registerCommand("lingofile.loadMeta", () => { getPanel()?.loadMetafilePath(); }),

     vscode.commands.registerCommand("lingofile.runBenchmark", () => {
       const p = getPanel();
       if (p) p.runBenchmark();
       else vscode.window.showWarningMessage("LingoFile panel not open.");
     }),
  );
}

export function deactivate(): void {
  LingoFilePanel.currentPanel?.dispose();
}

// ---- Webview HTML ----

function getWebviewHtml(): string {
  return require("fs").readFileSync(require("path").join(__dirname, "webview.html"), "utf-8");
}
