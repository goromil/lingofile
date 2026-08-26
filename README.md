# LingoFile — Large File Linguistic Viewer

View, decode, and analyse large text files — detect languages, scripts, encodings, and scan multi-language zones. Built for files from KBs to GBs with zero file load into memory.

## Features

- **Chunked reads** — reads 256 KB chunks on demand, never loads entire file
- **16+ encoding detection** — UTF-8/16 BOM, windows-1251, koi8-r, gb18030, shift_jis, big5, and more
- **Language detection** — franc-min powered language recognition (English, Russian, German, French, Chinese, Japanese, Korean, Armenian, Georgian, and 40+ more)
- **Script analysis** — Latin, Cyrillic, Greek, CJK, Hangul, Kana, Arabic, Hebrew, Armenian, Georgian, Thai, Devanagari, Math
- **Zone scanning** — fast (1 MB steps) or full (64 KB steps) scan to map language/encoding regions across the file
- **Visual zone map** — colored zone bar with click-to-jump navigation
- **Metafile export** — save/load `.meta.json` with zone analysis data
- **Three view modes** — Text (filtered), Hex dump, Raw
- **Parallel zone scan** — 8 concurrent reads for fast detection on SSD/NVMe

## Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| `lingofile.open` | — | Open large file picker |
| `lingofile.openActive` | — | Open active editor file |
| `lingofile.previewFile` | — | Preview file from explorer/editor context menu |
| `lingofile.focusSearch` | `Ctrl+Alt+F` | Focus search bar |
| `lingofile.focusOffset` | `Ctrl+Alt+G` | Focus offset input |
| `lingofile.toggleWrap` | `Ctrl+Alt+W` | Toggle text wrapping |
| `lingofile.reloadChunk` | `Ctrl+Alt+R` | Reload current chunk |
| `lingofile.nextPage` | `Ctrl+Alt+N` | Next page |
| `lingofile.prevPage` | `Ctrl+Alt+P` | Previous page |
| `lingofile.abortOperation` | `Escape` | Abort current operation |
| `lingofile.toggleSlider` | `Ctrl+Alt+L` | Toggle position slider |
| `lingofile.analyseChunk` | `Ctrl+Alt+A` | Analyse current chunk |
| `lingofile.analyseZones` | `Ctrl+Alt+Z` | Fast zone scan (1 MB steps) |
| `lingofile.analyseZonesFull` | — | Full zone scan (64 KB steps) |
| `lingofile.saveMeta` | `Ctrl+Alt+S` | Save zone analysis to metafile |
| `lingofile.loadMeta` | — | Load metafile |

## Building & Publishing

```bash
npm run compile     # Compile TypeScript, copy webview.html
npm test            # Run unit tests (91 tests)
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
| Statements | 97.8% |
| Branches | 91.0% |
| Functions | 100% |
| Lines | 97.8% |

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
