# LingoFile — Large File Linguistic Viewer

View, decode, and analyse large text files — detect languages, scripts, encodings, and scan multi-language zones. Built for files from KBs to GBs with zero file load into memory.

## Features

- **Chunked reads** — reads 256 KB chunks on demand, never loads entire file
- **16+ encoding detection** — UTF-8/16 BOM, windows-1251, koi8-r, gb18030, shift_jis, big5, and more
- **UTF-8 display** — text is always displayed as UTF-8; probe is for stats/filtering only (fallback when UTF-8 has >5% replacement chars)
- **Language detection** — franc-min powered language recognition (English, Russian, German, French, Chinese, Japanese, Korean, Armenian, Georgian, and 40+ more)
- **Script analysis** — Latin, Cyrillic, Greek, CJK, Hangul, Kana, Arabic, Hebrew, Armenian, Georgian, Thai, Devanagari, Math
- **Zone scanning** — fast (1 MB steps) or full (64 KB steps) scan to map language/encoding regions across the file
- **Visual zone map** — colored zone bar with click-to-jump navigation (segments, tags, and bar hover)
- **Zone gap filling** — skipped chunks (timeouts) are absorbed into adjacent zones — no false gaps
- **Metafile export** — save/load `.meta.json` with zone analysis data
- **Three view modes** — Text (filtered), Hex dump, Raw
- **Parallel zone scan** — 8 concurrent reads for fast detection on SSD/NVMe

## Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| `lingofile.open` | — | Open large file picker |
| `lingofile.openActive` | — | Open active editor file |
| `lingofile.previewFile` | — | Preview file from explorer/editor context menu |
| `lingofile.focusSearch` | `Ctrl+F` | Focus search bar (copies selection if any) |
| `lingofile.focusOffset` | `Ctrl+G` | Focus offset input |
| `lingofile.toggleWrap` | `Alt+Z` | Toggle text wrapping |
| `lingofile.reloadChunk` | `Ctrl+Alt+R` | Reload current chunk |
| `lingofile.nextPage` | `PageDown` | Next page |
| `lingofile.prevPage` | `PageUp` | Previous page |
| `lingofile.abortOperation` | `Escape` | Abort current operation |
| `lingofile.toggleSlider` | `Ctrl+Alt+L` | Toggle position slider |
| `lingofile.analyseChunk` | `Ctrl+Alt+A` | Analyse current chunk |
| `lingofile.analyseZones` | `Ctrl+Alt+Z` | Fast zone scan (1 MB steps) |
| `lingofile.analyseZonesFull` | — | Full zone scan (64 KB steps) |
| `lingofile.saveMeta` | — | Save zone analysis to metafile |
| `lingofile.loadMeta` | — | Load metafile |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `lingofile.zoneScanConcurrency` | `2` | Concurrent reads during zone scan: `1` (HDD/WSL), `2` (SSD), `8` (NVMe) |
| `lingofile.sigmaThreshold` | `3` | Sigma multiplier for slow-read threshold: `threshold = mean + N × CV × mean`. Uses CV from benchmark (or default 0.5). Default `3` catches outliers. Health indicators auto-calibrate after running benchmark. |
| `lingofile.maxCv` | `0.5` | Default healthy CV baseline. Actual `maxHealthyCV = 2 × maxCv` (or `2 × benchCV` after benchmark). Before benchmark: `maxHealthyCV=1.0`. After benchmark: recalibrated from measured CV. |
| `lingofile.zoneScanExcludeScripts` | `["Binary"]` | Scripts excluded from zone-scan language detection. Zones matching these scripts are tagged "Skipped" without running franc-min. Add more to skip scripts you don't want to detect. |

### Adaptive Health Indicators

LingoFile uses **benchmark-calibrated** thresholds. Before running a benchmark, it uses safe defaults. After benchmark, it recalibrates:

| Phase | `healthyCV` | `maxHealthyCV` | Notes |
|-------|-------------|----------------|-------|
| Pre-benchmark | `maxCv` (0.5) | `2 × maxCv` (1.0) | Conservative defaults |
| Post-benchmark | `benchCV` | `2 × benchCV` | Calibrated from your storage |

**`indicationIsSane` guard:** If `>3σ > 6 × benchCV` at benchmark time, health indicators are **auto-disabled** — the outliers would just noise the UI. Reset when you close the file and open a new one.

### How Thresholds Work

Both `sigmaThreshold` and `maxCv` are **dimensionless** — no time values in config. LingoFile measures `mean` and `stddev` at runtime:

| Config | Runtime conversion | Detects |
|--------|--------------------|---------|
| `sigmaThreshold: 3` | `threshold = mean + 3 × CV × mean` | Individual slow reads (HDD-R indicator) |
| `maxHealthyCV` | `if (CV > maxHealthyCV)` | Systemic instability (SPREAD indicator) |

**Example — SSD (CV=0.4):** threshold = 5ms + 3×0.4×5ms = 11ms. `maxHealthyCV=0.8` — passes.
**Example — HDD (CV=0.6):** threshold = 50ms + 3×0.6×50ms = 140ms. `maxHealthyCV=1.2` — passes.

## Benchmark

Measure zone-scan throughput, read-budget breakdown, and stability on your storage.

**In-editor:** Open a file in LingoFile, press `Ctrl+Shift+P` → `LingoFile: Run I/O Benchmark`. Runs 100 sequential fast-mode reads, recalibrates health indicators.

**CLI:**
```bash
npm run benchmark <file-path>
```

### Output Columns

| Column | Description |
|--------|-------------|
| `Mode` | `fast` (1 MB step) or `full` (64 KB step) |
| `Conc` | Concurrency: 1 (sequential), 2, 8 |
| `Reads` / `Zones` | Number of reads performed, zones found |
| `Wall` | Total wall-clock time |
| `Read%` | fs.read() time as % of total work (Read + Compute, always sums to 100%) |
| `Comp%` | CPU time (probe + lang + script) as % of total work |
| `R/s` | Reads per second |
| `Mean` / `Std` | Per-read mean time and standard deviation |
| `Min` / `Max` | Fastest and slowest read |
| `>3σ` | Count of reads exceeding `mean + 3×stddev` (outliers) |
| `CV` | Coefficient of Variation (`stddev / mean`). `⚠` marks CV > 0.5 (systemic instability) |

### Interpreting Results

**Storage type diagnosis:**

| Pattern | Meaning |
|---------|---------|
| Mean < 10ms, Std < 5ms | SSD / NVMe |
| Mean 20-50ms, Std 10-30ms | HDD or WSL/SSH |
| `>3σ` > 10% of reads | Seek thrashing — try `zoneScanConcurrency: 1` |
| `Read%` > 80% | I/O-bound, disk is the bottleneck |
| `Comp%` > 80% | CPU-bound, detection overhead dominates |

**Post-benchmark calibration:** After running the in-editor benchmark, LingoFile recalibrates `healthyCV = benchCV` and `maxHealthyCV = 2 × benchCV`. If `>3σ > 6 × benchCV`, health indicators are auto-disabled (too many outliers for useful warnings).

## Building & Publishing

```bash
npm run compile     # Compile TypeScript, copy webview.html
npm test            # Run unit tests (104 tests)
npm run coverage    # Coverage report (lcov + text)
npx vsce package    # Build .vsix for marketplace upload
```

### Version Bump

The version number appears in **4 files** — all must be updated together:

| File | Location | Purpose |
|------|----------|---------|
| `package.json` | `"version"` | Source of truth, used by `vsce` |
| `package-lock.json` | root `"version"` + `""` package | Auto-updated by `npm version` or `npm install` |
| `.vscode/launch.json` | `"version"` | Launch config metadata |
| `src/extension.ts` | `tool: \`lingofile@X.Y.Z\`` | Tool attribution in analysis output |

### Publishing to VS Code Marketplace

1. Bump version in all 4 files above
2. `npx vsce package` → produces `lingofile-X.Y.Z.vsix`
3. Upload `.vsix` at https://marketplace.visualstudio.com/manage/extensions
4. Users receive auto-update within ~24 hours

### Test Coverage

| Metric | Value |
|--------|-------|
| Statements | 98.2% |
| Branches | 92.5% |
| Functions | 100% |
| Lines | 98.2% |

## Architecture

- **Backend** (`src/extension.ts`) — `LingoFilePanel` class, file I/O, message handlers, zone scan orchestration
- **Utilities** (`src/utils.ts`) — Language detection, script analysis, encoding probe, chunk stats, hex dump, zone analysis
- **Frontend** (`src/webview.html`) — Webview UI with zone map, language panel, metafile panel, three view modes
- **Tests** (`src/test/`) — Unit tests for utils, integration tests for extension commands

## Project History

LingoFile is a TypeScript fork of [ExaPager](https://github.com/goromil/-exapagerj) with added linguistic analysis capabilities:
- Original Python variant: [word-gpt-mini](https://github.com/goromil/word-gpt-mini) / [exapagerpy](https://github.com/goromil/-exapagerpy)
- TypeScript fork without Python: [exapagerj](https://github.com/goromil/-exapagerj)
- With linguistic analysis: **lingofile** (this repo)
