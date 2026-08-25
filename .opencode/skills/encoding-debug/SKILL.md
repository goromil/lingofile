---
name: encoding-debug
description: Debug garbled text and encoding issues — BOM detection, heuristic encoding probe, cross-referencing hex view with decoded output
---

## What I do

- Diagnose encoding issues: garbled text, replacement characters, wrong character rendering
- Walk through the encoding probe logic to find best encoding
- Cross-reference hex dump with decoded text to identify encoding
- Help adjust encoding heuristics and byte-class analysis

## When to use me

Use when the user reports garbled text, mojibake, wrong encoding, replacement characters (), or asks about encoding detection.

## Key files

- `src/utils.ts` — `probeEncoding`, `chunkStats`, `findBadRanges`, `computeByteClasses`, `analyseChunk`, `isReadableChunk`
- `src/extension.ts` — auto-detect logic in `loadChunk`, encoding fallback
- `src/webview.html` — hex view, chunk stats panel

## Encoding probe logic

`probeEncoding(raw: Buffer)` tests 19 encodings in order:

1. **BOM check** (immediate return if found):
   - `EF BB BF` → utf-8
   - `FF FE` → utf-16le
   - `FE FF` → utf-16be

2. **Baseline scores**:
   - `utf-8`: count replacement characters ()
   - `ascii`: count bytes > 127
   - `latin1`: always 0 (lossless mapping)

3. **iconv-lite decode** for each candidate, count unprintable/replacement characters:
   - windows-1251, koi8-r, windows-1252, windows-1250, windows-1253, windows-1254
   - windows-1255, iso-8859-8, windows-1257
   - gb18030, gbk, shift_jis, euc-kr, big5
   - iso-8859-5, iso-8859-7, georgian-academy, maccyrillic

4. **Heuristic adjustments** (only when high bytes > 10% and utf-8 bad > 5%):
   - utf-8 badPct += 5 if badPct > 5%
   - CJK encodings (gbk, big5, shift_jis, euc-kr) -= 3 if CJK range bytes > 50% high bytes
   - windows-1251 -= 5 if Cyrillic bytes (0xC0-0xFF) > 30% high bytes
   - koi8-r -= 5 if KOI8 range (0xA0-0xFF) > 40% high bytes
   - Hebrew encodings (windows-1255, iso-8859-8) -= 3 if 0xE0-0xFF > 30% high bytes and > 5% total
   - georgian-academy -= 3 if 0xE0-0xEF > 50% high bytes

5. **Sort by badPct** ascending, return sorted list

## Auto-detect in loadChunk

In `extension.ts:loadChunk`, after decoding with current encoding:
- If `stats.replacedPct > 5`, try `stats.bestEncoding`
- If alternative decode has < 5% replacement chars, switch encoding

## Byte classes

`computeByteClasses` categorizes raw bytes into:
- `null`, `control_01_1f`, `del` (0x7F)
- `ascii_print` (0x20-0x7E)
- `c1_controls` (0x80-0x9F)
- `utf8_cont` (0x80-0xBF), `utf8_start2` (0xC0-0xDF), `utf8_start3` (0xE0-0xEF), `utf8_start4` (0xF0-0xF7)
- `overlong_bom` (0xFE, 0xFF)

## Debugging steps

1. Run `lingofile.analyseChunk` (Ctrl+Shift+A) at the problematic offset
2. Check `encodingProbe` results — top candidates with badPct
3. Switch to hex view — look for byte patterns:
   - Double-byte sequences → CJK
   - 0xC0-0xFF with leading bytes → windows-1251 Cyrillic
   - 0x81-0xFE pairs → Shift_JIS
4. If auto-detect failed, try `lingofile.reloadChunk` after adjusting encoding
5. Check `badRanges` for specific problematic byte sequences

## Commands

- `lingofile.analyseChunk` — chunk analysis with encoding probe (Ctrl+Shift+A)
- `lingofile.reloadChunk` — reload current chunk (F5)
- Hex view — switch via view mode buttons
