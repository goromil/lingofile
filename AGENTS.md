# LingoFile — Agent Context

VS Code extension for viewing and linguistically analysing large text files with zone scanning, language/script detection, metafile export, and parallel I/O.

## Project Layout

```
src/
  extension.ts       # LingoFilePanel singleton, 21 commands, message handlers, parallel zone scan
  utils.ts           # detectLanguage, detectScripts, probeEncoding, analyseZoneScan, filterText, chunkStats
  webview.html       # Zone map, language panel, metafile panel, text/hex/raw views
  test/
    utils.test.ts    # 91 unit tests, 97.8% coverage
    extension.test.ts  # 2 integration tests
package.json         # 21 commands, 11 keybindings, scripts
```

## Build Commands

```bash
npm run compile      # TypeScript compile + copy webview.html
npm test             # 91 unit tests
npm run coverage     # c8 coverage report
npm run test:vscode  # VS Code integration tests
```

## Architecture

- **`LingoFilePanel`** — singleton panel, single `loadSeq` guard for stale reads
- **Zone scan** — fast (1 MB steps) / full (64 KB steps), 8 concurrent reads per batch
- **Language detection** — `franc-min`, confidence scoring
- **Script detection** — 15 scripts: Latin, Cyrillic, Greek, CJK, Hangul, Kana, Arabic, Hebrew, Armenian, Georgian, Devanagari, Thai, Math, Punctuation, Binary
- **Encoding probe** — 19 encodings: UTF-8/16 BOM, windows-125x, ISO-8859, GBK, Shift_JIS, Big5, EUC-KR, georgian-academy, maccyrillic
- **Metafile** — `.meta.json`, zones + summary + encoding probe, auto-loaded on file open
- **`filterText`** — strips control chars, collapses whitespace, unescapes HTML entities

## Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `CHUNK_SIZE` | 256 KB | Chunk read size |
| `ZONE_FAST_STEP` | 1 MB | Fast zone scan step |
| `ZONE_FULL_STEP` | 64 KB | Full zone scan step |
| `ZONE_WINDOW` | 32 KB | Analysis window per zone |
| `ZONE_CONCURRENCY` | 8 | Parallel reads per batch |

## Provenance

Fork of `exapagerj` (`C:\Users\gorom\source\ai\exapagerj`). Python variants: `exapagerpy`, `word-gpt-mini`.
