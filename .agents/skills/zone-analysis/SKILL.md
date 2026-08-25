---
name: zone-analysis
description: Analyze multi-language zones in large files — zone scanning, language detection, script analysis, and metafile export
---

## What I do

- Run fast or full zone scans across large files to map language/encoding regions
- Interpret zone scan results: languages, scripts, readability per zone
- Debug zone boundaries and merging behavior
- Help with metafile export and reload

## When to use me

Use when the user asks about zone scanning, language regions, zone map, metafiles, or multi-language file analysis.

## Key files

- `src/utils.ts` — `detectLanguage`, `detectScripts`, `dominantScript`, `analyseZoneScan`, `computeZoneSummary`, `ChunkScan`, `ZoneEntry`, `ZoneSummary`, `Metafile`
- `src/extension.ts` — `runZoneScan`, `saveMetafile`, `loadMetafilePath`, `jumpToZone`, `metafile`
- `src/webview.html` — zone map rendering, zone click handlers, language panel

## Zone scan workflow

1. `runZoneScan("fast")` or `runZoneScan("full")` in `extension.ts`
2. Builds offset list stepping by `ZONE_FAST_STEP` (1 MB) or `ZONE_FULL_STEP` (64 KB)
3. Reads `ZONE_WINDOW` (32 KB) at each offset with `ZONE_CONCURRENCY` (8) parallel reads
4. For each read: probes encoding, decodes text, detects language via `franc-min`, detects scripts
5. Collects `ChunkScan[]` results, passes to `analyseZoneScan` to group into zones
6. `analyseZoneScan` merges consecutive chunks with same encoding+language+script
7. `mergeAdjacentZones` further merges zones with same language+script (readablePct > 5%)
8. `computeZoneSummary` aggregates language/script distribution
9. Posts `zonesDone` to webview with zones, summary, mode

## Zone interfaces

```ts
interface ZoneEntry {
  id, offset, length, encoding, language, languageConfidence,
  script, scriptPct, readablePct, label
}
interface ZoneSummary {
  totalZones, languages, scripts, readablePct, zonesAnalysed, scanDuration
}
```

## Metafile format

`<filename>.meta.json` — auto-loaded on file open if present and size matches:
- `version`, `tool`, `created`
- `file`: name, size, mtime
- `encoding`: primary + top-4 probe results
- `zones`: ZoneEntry[]
- `summary`: ZoneSummary

## Debugging zones

- Check `readablePct` — if zones show low readability, encoding probe may be wrong
- Zone boundaries at encoding transitions are expected
- `mergeAdjacentZones` requires both zones > 5% readable to merge
- Use full scan (64 KB steps) for fine-grained boundaries

## Commands

- `lingofile.analyseZones` — fast scan (Ctrl+Shift+Z)
- `lingofile.analyseZonesFull` — full scan
- `lingofile.saveMeta` — save metafile (Ctrl+Shift+M)
- `lingofile.loadMeta` — load metafile
- `lingofile.jumpZone` — quick-pick zone list, navigate to selected
