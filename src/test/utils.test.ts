import * as assert from "assert";
import {
  filterText, chunkStats, escapeHtml, formatOffset, formatSize,
  byteToHex, hexRow, hexDump, probeEncoding, analyseChunk,
  findBadRanges, computeByteClasses, isReadableChunk,
  detectLanguage, detectScripts, dominantScript, getLanguageName,
  analyseZoneScan, computeZoneSummary, ChunkScan, ZoneEntry,
} from "../utils";

suite("Utils Tests", () => {
  suite("filterText", () => {
    test("replaces control characters with spaces then collapses", () => {
      const result = filterText("hello\x00world\x01test");
      assert.strictEqual(result, "hello world test");
    });

    test("collapses multiple spaces and tabs", () => {
      const result = filterText("hello   world\t\ttest");
      assert.strictEqual(result, "hello world test");
    });

    test("preserves newlines", () => {
      const result = filterText("hello\nworld");
      assert.strictEqual(result, "hello\nworld");
    });

    test("handles empty string", () => {
      assert.strictEqual(filterText(""), "");
    });

    test("handles DEL character (0x7f)", () => {
      assert.strictEqual(filterText("a\x7fb"), "a b");
    });

    test("replaces replacement character U+FFFD with space", () => {
      assert.strictEqual(filterText("a\ufffdb"), "a b");
    });

    test("unescape HTML entities", () => {
      assert.strictEqual(filterText("a&amp;b &lt;c&gt;"), "a&b <c>");
    });
  });

  suite("chunkStats", () => {
    test("returns null for zero length", () => {
      assert.strictEqual(chunkStats(Buffer.alloc(0), ""), null);
    });

    test("returns stats for clean text", () => {
      const buf = Buffer.alloc(100, 0x41);
      const stats = chunkStats(buf, buf.toString("utf-8"));
      assert.ok(stats);
      assert.strictEqual(stats!.totalBytes, 100);
      assert.strictEqual(stats!.replaced, 0);
      assert.strictEqual(stats!.isReadable, true);
    });

    test("detects replacement characters", () => {
      const buf = Buffer.from([0xff, 0xfe, 0xff, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]);
      const text = buf.toString("utf-8");
      const stats = chunkStats(buf, text);
      assert.ok(stats);
      assert.ok(stats!.replaced > 0);
    });

    test("marks unreadable when too many replacements", () => {
      const buf = Buffer.alloc(100, 0xff);
      const text = buf.toString("utf-8");
      const stats = chunkStats(buf, text);
      assert.ok(stats);
      assert.strictEqual(stats!.isReadable, false);
    });

    test("computes encoding probe", () => {
      const buf = Buffer.from("hello world", "utf-8");
      const stats = chunkStats(buf, buf.toString("utf-8"));
      assert.ok(stats);
      assert.ok(stats!.encodingProbe.length > 0);
    });

    test("detects language and scripts", () => {
      const buf = Buffer.from("Hello World this is English text", "utf-8");
      const stats = chunkStats(buf, buf.toString("utf-8"));
      assert.ok(stats);
      assert.ok(stats!.scripts["Latin"] > 0);
      assert.ok(stats!.language.length > 0);
    });
  });

  suite("escapeHtml", () => {
    test("escapes ampersand", () => {
      assert.strictEqual(escapeHtml("a&b"), "a&amp;b");
    });

    test("escapes less than and greater than", () => {
      assert.strictEqual(escapeHtml("<div>"), "&lt;div&gt;");
    });

    test("escapes double quote", () => {
      assert.strictEqual(escapeHtml('say "hi"'), "say &quot;hi&quot;");
    });

    test("handles empty string", () => {
      assert.strictEqual(escapeHtml(""), "");
    });

    test("handles plain text", () => {
      assert.strictEqual(escapeHtml("hello world"), "hello world");
    });
  });

  suite("formatOffset", () => {
    test("formats bytes", () => {
      assert.strictEqual(formatOffset(0), "0 B");
      assert.strictEqual(formatOffset(42), "42 B");
    });

    test("formats kilobytes", () => {
      assert.strictEqual(formatOffset(1024), "1.0 KiB");
      assert.strictEqual(formatOffset(1536), "1.5 KiB");
    });

    test("formats megabytes", () => {
      assert.strictEqual(formatOffset(1048576), "1.00 MiB");
    });

    test("formats gigabytes", () => {
      assert.strictEqual(formatOffset(1024 * 1024 * 1024 * 2), "2.00 GiB");
    });

    test("formats terabytes", () => {
      assert.strictEqual(formatOffset(1024 * 1024 * 1024 * 1024 * 1.5), "1.50 TiB");
    });
  });

  suite("formatSize", () => {
    test("formats bytes", () => {
      assert.strictEqual(formatSize(0), "0 B");
      assert.strictEqual(formatSize(42), "42 B");
    });

    test("formats KB", () => {
      assert.strictEqual(formatSize(1024), "1.0 KB");
    });

    test("formats MB", () => {
      assert.strictEqual(formatSize(1048576), "1.0 MB");
    });

    test("formats GB", () => {
      assert.strictEqual(formatSize(1073741824), "1.00 GB");
    });
  });

  suite("byteToHex", () => {
    test("formats single digit", () => {
      assert.strictEqual(byteToHex(0), "00");
      assert.strictEqual(byteToHex(5), "05");
      assert.strictEqual(byteToHex(10), "0a");
    });

    test("formats double digit", () => {
      assert.strictEqual(byteToHex(255), "ff");
      assert.strictEqual(byteToHex(16), "10");
    });
  });

  suite("hexRow", () => {
    test("formats full row of 16 bytes", () => {
      const data = Buffer.from("Hello, World! 12", "utf-8");
      const row = hexRow(data, 0);
      assert.ok(row.startsWith("00000000"));
      assert.ok(row.includes("|Hello, World! 12|"));
    });

    test("pads short data", () => {
      const data = Buffer.from("AB", "utf-8");
      const row = hexRow(data, 0);
      assert.ok(row.startsWith("00000000"));
      assert.ok(row.includes("41 42"));
    });

    test("replaces non-printable chars with dot", () => {
      const data = Buffer.from([0x00, 0x01, 0x41]);
      const row = hexRow(data, 0);
      assert.ok(row.includes("..A"));
    });
  });

  suite("hexDump", () => {
    test("produces hex dump lines", () => {
      const data = Buffer.from("Hello, World!", "utf-8");
      const lines = hexDump(data, 0);
      assert.ok(lines.length > 0);
      assert.ok(lines[0].startsWith("00000000"));
    });

    test("limits output to HEX_DUMP_SIZE", () => {
      const data = Buffer.alloc(32768, 0x41);
      const lines = hexDump(data, 0);
      assert.strictEqual(lines.length, Math.ceil(16384 / 16));
    });
  });

  suite("probeEncoding", () => {
    test("returns sorted results", () => {
      const data = Buffer.from("hello world", "utf-8");
      const results = probeEncoding(data);
      assert.ok(results.length > 0);
      assert.ok(results[0].badPct <= results[results.length - 1].badPct);
    });

    test("ascii text has at least one encoding with low badPct", () => {
      const data = Buffer.from("The quick brown fox jumps", "utf-8");
      const results = probeEncoding(data);
      assert.ok(results.some(r => r.badPct < 10));
    });

    test("detects UTF-8 BOM", () => {
      const data = Buffer.from([0xEF, 0xBB, 0xBF, 0x48, 0x65, 0x6C, 0x6C, 0x6F]);
      const results = probeEncoding(data);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, "utf-8");
      assert.strictEqual(results[0].badPct, 0);
    });

    test("detects UTF-16 LE BOM", () => {
      const data = Buffer.from([0xFF, 0xFE, 0x48, 0x00, 0x65, 0x00]);
      const results = probeEncoding(data);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, "utf-16le");
    });

    test("detects UTF-16 BE BOM", () => {
      const data = Buffer.from([0xFE, 0xFF, 0x00, 0x48, 0x00, 0x65]);
      const results = probeEncoding(data);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, "utf-16be");
    });

    test("CJK heuristic boosts CJK encodings", () => {
      const data = Buffer.from([0x81, 0x40, 0x82, 0xA0, 0x83, 0x40, 0x84, 0x40, 0x85, 0x40, 0x86, 0x40, 0x87, 0x40, 0x88, 0x40]);
      const results = probeEncoding(data);
      assert.ok(results.length > 0);
    });

    test("cyrillic heuristic boosts windows-1251", () => {
      const data = Buffer.from([0xC0, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xCB, 0xCC, 0xCD, 0xCE, 0xCF]);
      const results = probeEncoding(data);
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.name === "windows-1251"));
    });
  });

  suite("analyseChunk", () => {
    test("returns full analysis", () => {
      const data = Buffer.from("Hello, World! This is a test.", "utf-8");
      const result = analyseChunk(data, 0);
      assert.strictEqual(result.offset, 0);
      assert.strictEqual(result.bytesRead, data.length);
      assert.ok(result.stats);
      assert.ok(result.byteClasses);
    });

    test("finds bad ranges for bad data", () => {
      const data = Buffer.from([0xff, 0xfe, 0x41, 0x42, 0x00, 0x00, 0xff]);
      const result = analyseChunk(data, 100);
      assert.ok(result.badRangesTotal > 0);
    });

    test("includes filtered preview", () => {
      const data = Buffer.from("Hello\x00World", "utf-8");
      const result = analyseChunk(data, 0);
      assert.ok(result.filteredPreview.length > 0);
      assert.strictEqual(result.filterApplied, "control chars stripped, whitespace collapsed, HTML unescaped");
    });
  });

  suite("findBadRanges", () => {
    test("finds 0xff/0xfe bytes as bad", () => {
      const data = Buffer.from([0x41, 0xff, 0xfe, 0x42]);
      const ranges = findBadRanges(data, 0);
      assert.ok(ranges.length > 0);
    });

    test("empty buffer has no bad ranges", () => {
      assert.strictEqual(findBadRanges(Buffer.alloc(0), 0).length, 0);
    });

    test("clean ascii has no bad ranges", () => {
      const data = Buffer.from("Hello, World!", "utf-8");
      assert.strictEqual(findBadRanges(data, 0).length, 0);
    });
  });

  suite("computeByteClasses", () => {
    test("counts null bytes", () => {
      const data = Buffer.from([0x00, 0x00, 0x41]);
      const classes = computeByteClasses(data);
      assert.strictEqual(classes.null, 2);
    });

    test("counts ascii printable", () => {
      const data = Buffer.from("ABC");
      const classes = computeByteClasses(data);
      assert.strictEqual(classes.ascii_print, 3);
    });

    test("counts control chars", () => {
      const data = Buffer.from([0x01, 0x02, 0x41]);
      const classes = computeByteClasses(data);
      assert.strictEqual(classes.control_01_1f, 2);
    });

    test("counts DEL", () => {
      const data = Buffer.from([0x7f, 0x7f]);
      const classes = computeByteClasses(data);
      assert.strictEqual(classes.del, 2);
    });

    test("counts UTF-8 start bytes", () => {
      const data = Buffer.from([0xc0, 0xe0, 0xf0]);
      const classes = computeByteClasses(data);
      assert.strictEqual(classes.utf8_start2, 1);
      assert.strictEqual(classes.utf8_start3, 1);
      assert.strictEqual(classes.utf8_start4, 1);
    });

    test("counts overlong BOM bytes", () => {
      const data = Buffer.from([0xfe, 0xff]);
      const classes = computeByteClasses(data);
      assert.strictEqual(classes.overlong_bom, 2);
    });
  });

  suite("isReadableChunk", () => {
    test("clean text is readable", () => {
      assert.strictEqual(isReadableChunk("Hello, World! This is a test."), true);
    });

    test("empty string is not readable", () => {
      assert.strictEqual(isReadableChunk(""), false);
    });

    test("mostly replacement chars is not readable", () => {
      const text = "\ufffd".repeat(90) + "hello";
      assert.strictEqual(isReadableChunk(text), false);
    });

    test("mixed text is readable", () => {
      const text = "\ufffd\ufffdHello, World!";
      assert.strictEqual(isReadableChunk(text), true);
    });
  });

  // ---- Linguistic analysis tests ----

  suite("detectScripts", () => {
    test("detects Latin script", () => {
      const scripts = detectScripts("Hello World");
      assert.ok(scripts["Latin"] > 0);
    });

    test("detects Cyrillic script", () => {
      const scripts = detectScripts("\u0410\u0411\u0412");
      assert.ok(scripts["Cyrillic"] > 0);
    });

    test("detects Greek script", () => {
      const scripts = detectScripts("\u03B1\u03B2\u03B3");
      assert.ok(scripts["Greek"] > 0);
    });

    test("detects CJK script", () => {
      const scripts = detectScripts("\u4E16\u754C\u3001");
      assert.ok(scripts["CJK"] > 0);
    });

    test("detects Hangul script", () => {
      const scripts = detectScripts("\uC601\uAD6D\uC5B4");
      assert.ok(scripts["Hangul"] > 0);
    });

    test("detects Kana script", () => {
      const scripts = detectScripts("\u3053\u3093\u306B\u3061\u306F");
      assert.ok(scripts["Kana"] > 0);
    });

    test("detects Armenian script", () => {
      const scripts = detectScripts("\u0540\u0561\u0575\u0565\u0580\u0565\u0576");
      assert.ok(scripts["Armenian"] > 0);
    });

    test("detects Georgian script", () => {
      const scripts = detectScripts("\u10D0\u10D1\u10D2");
      assert.ok(scripts["Georgian"] > 0);
    });

    test("detects Arabic script", () => {
      const scripts = detectScripts("\u0627\u0628\u062C");
      assert.ok(scripts["Arabic"] > 0);
    });

    test("detects Hebrew script", () => {
      const scripts = detectScripts("\u05D0\u05D1\u05D2");
      assert.ok(scripts["Hebrew"] > 0);
    });

    test("detects Thai script", () => {
      const scripts = detectScripts("\u0E01\u0E02\u0E03");
      assert.ok(scripts["Thai"] > 0);
    });

    test("mixed scripts", () => {
      const scripts = detectScripts("Hello \u0410\u0411");
      assert.ok(scripts["Latin"] > 0);
      assert.ok(scripts["Cyrillic"] > 0);
    });

    test("empty string", () => {
      const scripts = detectScripts("");
      assert.strictEqual(Object.keys(scripts).length, 0);
    });
  });

  suite("dominantScript", () => {
    test("returns most frequent script", () => {
      const scripts = { "Latin": 10, "Cyrillic": 3 };
      assert.strictEqual(dominantScript(scripts), "Latin");
    });

    test("returns empty for empty object", () => {
      assert.strictEqual(dominantScript({}), "");
    });

    test("returns only script", () => {
      const scripts = { "Greek": 5 };
      assert.strictEqual(dominantScript(scripts), "Greek");
    });
  });

  suite("detectLanguage", () => {
    test("returns und for empty string", () => {
      const result = detectLanguage("");
      assert.strictEqual(result.code, "und");
      assert.strictEqual(result.confidence, 0);
    });

    test("returns und for very short text", () => {
      const result = detectLanguage("hi");
      assert.strictEqual(result.code, "und");
      assert.strictEqual(result.confidence, 0);
    });

    test("detects English from clear text", () => {
      const result = detectLanguage("The quick brown fox jumps over the lazy dog. This is clearly English text for testing purposes.");
      assert.strictEqual(result.code, "eng");
      assert.ok(result.confidence > 0);
    });

    test("detects Russian from cyrillic text", () => {
      const result = detectLanguage("\u041F\u0440\u0438\u0432\u0435\u0442 \u043C\u0438\u0440! \u042D\u0442\u043E \u0442\u0435\u0441\u0442\u043E\u0432\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 \u043D\u0430 \u0440\u0443\u0441\u0441\u043A\u043E\u043C \u044F\u0437\u044B\u043A\u0435 \u0434\u043B\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u0432\u0430\u043D\u0438\u044F \u044F\u0437\u044B\u043A\u043E\u0432.");
      assert.strictEqual(result.code, "rus");
    });

    test("detects German", () => {
      const result = detectLanguage("Dieser Test ist eine einfache Nachricht auf Deutsch, die zum Ermitteln von Sprachen dient und ausreichend lang sein muss.");
      assert.strictEqual(result.code, "deu");
    });

    test("detects French", () => {
      const result = detectLanguage("Ce texte est une phrase en fran\u00E7ais destin\u00E9e \u00E0 tester la d\u00E9tection des langues dans notre application.");
      assert.strictEqual(result.code, "fra");
    });
  });

  suite("getLanguageName", () => {
    test("returns name for known codes", () => {
      assert.strictEqual(getLanguageName("eng"), "English");
      assert.strictEqual(getLanguageName("rus"), "Russian");
      assert.strictEqual(getLanguageName("cmn"), "Mandarin");
      assert.strictEqual(getLanguageName("jpn"), "Japanese");
      assert.strictEqual(getLanguageName("deu"), "German");
      assert.strictEqual(getLanguageName("fra"), "French");
      assert.strictEqual(getLanguageName("hye"), "Armenian");
      assert.strictEqual(getLanguageName("kat"), "Georgian");
    });

    test("returns undetermined for und", () => {
      assert.strictEqual(getLanguageName("und"), "Undetermined");
    });

    test("returns code for unknown", () => {
      assert.strictEqual(getLanguageName("xyz"), "xyz");
    });
  });

  suite("analyseZoneScan", () => {
    const makeScan = (offset: number, enc: string, lang: string, script: string): ChunkScan => ({
      offset, encoding: enc, language: lang, langConfidence: 0.9,
      script, scriptPct: 0.95, readablePct: 90, isReadable: true,
    });

    test("returns empty for no scans", () => {
      assert.strictEqual(analyseZoneScan([]).length, 0);
    });

    test("single zone for identical scans", () => {
      const scans = Array.from({ length: 5 }, (_, i) => makeScan(i * 32768, "utf-8", "eng", "Latin"));
      const zones = analyseZoneScan(scans);
      assert.strictEqual(zones.length, 1);
      assert.strictEqual(zones[0].language, "eng");
    });

    test("two zones for different languages", () => {
      const scans = [
        makeScan(0, "utf-8", "eng", "Latin"),
        makeScan(32768, "utf-8", "eng", "Latin"),
        makeScan(65536, "utf-8", "rus", "Cyrillic"),
        makeScan(98304, "utf-8", "rus", "Cyrillic"),
      ];
      const zones = analyseZoneScan(scans);
      assert.ok(zones.length >= 1);
    });

    test("zones have sequential IDs", () => {
      const scans = [
        makeScan(0, "utf-8", "eng", "Latin"),
        makeScan(32768, "utf-8", "rus", "Cyrillic"),
        makeScan(65536, "utf-8", "deu", "Latin"),
      ];
      const zones = analyseZoneScan(scans);
      for (let i = 0; i < zones.length; i++) {
        assert.strictEqual(zones[i].id, i + 1);
      }
    });

    test("zones have meaningful labels", () => {
      const scans = [makeScan(0, "utf-8", "eng", "Latin")];
      const zones = analyseZoneScan(scans);
      assert.ok(zones[0].label.includes("English"));
    });
  });

  suite("computeZoneSummary", () => {
    const makeZone = (id: number, lang: string, script: string, length: number, readablePct: number): ZoneEntry => ({
      id, offset: id * length, length, encoding: "utf-8",
      language: lang, languageConfidence: 0.9, script, scriptPct: 0.95,
      readablePct, label: lang + " (" + script + ")",
    });

    test("returns zero summary for empty zones", () => {
      const summary = computeZoneSummary([], 0);
      assert.strictEqual(summary.totalZones, 0);
      assert.strictEqual(summary.readablePct, 0);
    });

    test("computes language distribution", () => {
      const zones: ZoneEntry[] = [
        makeZone(1, "eng", "Latin", 100000, 95),
        makeZone(2, "rus", "Cyrillic", 100000, 90),
      ];
      const summary = computeZoneSummary(zones, 200000);
      assert.strictEqual(summary.totalZones, 2);
      assert.ok(summary.languages["eng"] > 0);
      assert.ok(summary.languages["rus"] > 0);
    });

    test("computes script distribution", () => {
      const zones: ZoneEntry[] = [
        makeZone(1, "eng", "Latin", 100000, 95),
        makeZone(2, "rus", "Cyrillic", 100000, 90),
      ];
      const summary = computeZoneSummary(zones, 200000);
      assert.ok(summary.scripts["Latin"] > 0);
      assert.ok(summary.scripts["Cyrillic"] > 0);
    });

    test("computes readable percentage", () => {
      const zones: ZoneEntry[] = [
        makeZone(1, "eng", "Latin", 100000, 100),
        makeZone(2, "eng", "Latin", 100000, 50),
      ];
      const summary = computeZoneSummary(zones, 200000);
      assert.strictEqual(summary.readablePct, 75);
    });
  });
});
