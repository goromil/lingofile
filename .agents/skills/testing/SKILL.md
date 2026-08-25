---
name: testing
description: Add tests, fix coverage, run mocha test suites for lingofile — utils unit tests and VS Code integration tests
---

## What I do

- Add unit tests for utils functions in `src/test/utils.test.ts`
- Add integration tests in `src/test/extension.test.ts`
- Run tests and coverage reports
- Fix coverage gaps to maintain 97%+ coverage

## When to use me

Use when the user asks to add tests, fix coverage, or verify test results.

## Test structure

```
src/test/
  utils.test.ts      # 91 unit tests, mocha TDD style, c8 coverage
  extension.test.ts  # 2 integration tests, @vscode/test-electron
  runTest.js         # compiled from runTest.ts, entry for test:vscode
```

## Running tests

```bash
npm run compile      # must run first to get out/ compiled
npm test             # mocha unit tests
npm run coverage     # c8 coverage (lcov + text)
npm run test:vscode  # VS Code integration tests
```

## Test conventions

- **TDD style**: `suite()`, `test()` from mocha
- Import from `../utils` (source files, not compiled)
- Use `assert` from `assert` module
- Test edge cases: empty inputs, short strings, binary data, boundary conditions
- Use `Buffer.from` for binary test data
- Use hex strings for specific byte sequences: `Buffer.from("efbbbf", "hex")` for UTF-8 BOM

## Coverage targets

| Metric | Target |
|--------|--------|
| Statements | 97.8%+ |
| Branches | 91%+ |
| Functions | 100% |
| Lines | 97.8%+ |

## Key functions to test in utils.ts

- `detectLanguage` — short text, non-text, various languages
- `detectScripts` — each script range, mixed scripts, empty
- `dominantScript` — single, tied, empty
- `probeEncoding` — BOM variants, each encoding, heuristic adjustments
- `analyseZoneScan` — single zone, transitions, adjacent merge
- `computeZoneSummary` — empty, single, multiple zones
- `filterText` — control chars, whitespace, HTML entities, clean text
- `chunkStats` — readable, binary, mixed, empty
- `isReadableChunk` — boundary cases at 50% threshold
- `hexDump`, `hexRow` — formatting, short data
- `findBadRanges` — clean, mixed, all bad
- `computeByteClasses` — distribution coverage
- `formatSize`, `formatOffset`, `escapeHtml` — formatting

## Adding a test

1. Add `test()` block in appropriate `suite()` in `src/test/utils.test.ts`
2. Use Buffer constructors for binary data: `Buffer.alloc(n)`, `Buffer.from(bytes)`
3. Verify with `assert.strictEqual`, `assert.ok`, `assert.deepStrictEqual`
4. Run `npm test` to verify
5. Run `npm run coverage` to check coverage impact
