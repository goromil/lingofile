# LingoFile — Agent Context

VS Code extension for viewing and linguistically analysing large text files with zone scanning, language/script detection, metafile export, and parallel I/O.

## Project Layout

```
src/
  extension.ts       # LingoFilePanel singleton, 20 commands, message handlers, parallel zone scan, jumpZone routing
  utils.ts           # detectLanguage, detectScripts, probeEncoding, analyseZoneScan, fillZoneGaps, filterText, chunkStats
  webview.html       # Zone map (click-to-jump), language panel, metafile panel, text/hex/raw views
  test/
    utils.test.ts    # 104 unit tests, 98.2% coverage
    extension.test.ts  # 2 integration tests
package.json         # 20 commands, 11 keybindings, scripts
```

## Build Commands

```bash
npm run compile      # TypeScript compile + copy webview.html
npm test             # 91 unit tests
npm run coverage     # c8 coverage report
npm run test:vscode  # VS Code integration tests
npx vsce package     # Build .vsix for marketplace upload
```

## Version Bump Checklist

The version number lives in **4 files** — bump all before packaging:

| File | Location | Auto? |
|------|----------|-------|
| `package.json` | `"version"` | No (source of truth) |
| `package-lock.json` | root `"version"` + `""` package | `npm version X.Y.Z --no-git-tag-version` |
| `.vscode/launch.json` | `"version"` | No |
| `src/extension.ts` | `tool: \`lingofile@X.Y.Z\`` (line ~331) | No |

After bumping: `npm run compile && npm test && npx vsce package`

Upload `.vsix` at https://marketplace.visualstudio.com/manage/extensions

## Architecture

- **`LingoFilePanel`** — singleton panel, single `loadSeq` guard for stale reads
- **Zone scan** — fast (1 MB steps) / full (64 KB steps), configurable concurrency via `lingofile.zoneScanConcurrency`
- **Language detection** — `franc-min`, confidence scoring
- **Script detection** — 15 scripts: Latin, Cyrillic, Greek, CJK, Hangul, Kana, Arabic, Hebrew, Armenian, Georgian, Devanagari, Thai, Math, Punctuation, Binary
- **Encoding probe** — 19 encodings: UTF-8/16 BOM, windows-125x, ISO-8859, GBK, Shift_JIS, Big5, EUC-KR, georgian-academy, maccyrillic
- **Display encoding** — Always UTF-8. Falls back to probe best only when UTF-8 has >5% replacement chars (U+FFFD). Probe is for stats/filtering, not primary display.
- **Metafile** — `.meta.json`, zones + summary + encoding probe, auto-loaded on file open
- **`filterText`** — strips control chars, collapses whitespace, unescapes HTML entities
- **Read timing** — `ReadStats`, `runningMean`, `runningStddev` in `utils.ts`; per-read timing in `readFileRange`
- **HDD-R detector** — flags individual slow reads when `elapsed > mean + sigmaThreshold × stddev` (configurable, dimensionless)
- **Spread detector** — flags systemic instability when `CV = stddev/mean > maxCv` (configurable, dimensionless)

## Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `CHUNK_SIZE` | 256 KB | Chunk read size |
| `ZONE_FAST_STEP` | 1 MB | Fast zone scan step |
| `ZONE_FULL_STEP` | 64 KB | Full zone scan step |
| `ZONE_WINDOW` | 32 KB | Analysis window per zone |
| `ZONE_CONCURRENCY` | 8 | Parallel reads per batch |

## Read Timing & Stability Detection

Both thresholds are **dimensionless** — LingoFile measures `mean` and `stddev` at runtime and converts to time values.

| Config | Default | Description |
|--------|---------|-------------|
| `lingofile.sigmaThreshold` | `3` | Multiplier for slow-read threshold: `threshold = mean + sigmaThreshold × CV × mean` |
| `lingofile.maxCv` | `0.5` | Default healthy CV baseline. `maxHealthyCV = 2 × maxCv` (or `2 × benchCV` after benchmark) |

**Adaptive calibration:** Before benchmark: `healthyCV = maxCv (0.5)`, `maxHealthyCV = 1.0`. After benchmark: `healthyCV = benchCV`, `maxHealthyCV = 2 × benchCV`.

**`indicationIsSane`:** Health indicators are auto-disabled when `>3σ > 6 × benchCV` — means outliers dominate and the indicators would just noise the UI. Reset on file close.

**Why dimensionless?** SSDs have mean~5ms, CV~0.4. HDDs have mean~50ms, CV~0.4. Same config values produce correct absolute thresholds on both. Threshold uses CV from benchmark (or default 0.5), so it scales with actual storage characteristics.

## Provenance

Fork of `exapagerj` (`C:\Users\gorom\source\ai\exapagerj`). Python variants: `exapagerpy`, `word-gpt-mini`.
