import * as path from "path";
import * as assert from "assert";
import * as vscode from "vscode";

suite("LingoFile Extension Integration Tests", () => {
  const testDir = path.join(__dirname, "..", "..", "..", "testfiles");

  suiteSetup(async () => {
    const fs = require("fs");
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    // Small test file
    const testFile = path.join(testDir, "test.txt");
    if (!fs.existsSync(testFile)) {
      fs.writeFileSync(testFile, "Hello, LingoFile!\nThis is a test file.\nLine 3.\n");
    }

    // Larger test file
    const largeFile = path.join(testDir, "large.txt");
    if (!fs.existsSync(largeFile)) {
      const lines = [];
      for (let i = 0; i < 1000; i++) {
        lines.push(`Line ${i}: This is test content for line number ${i}.`);
      }
      fs.writeFileSync(largeFile, lines.join("\n"));
    }

    // Mixed language test file
    const mixedFile = path.join(testDir, "mixed.txt");
    if (!fs.existsSync(mixedFile)) {
      fs.writeFileSync(mixedFile,
        "English section: The quick brown fox jumps over the lazy dog. This is English text for testing purposes.\n" +
        "\u0420\u0443\u0441\u0441\u043A\u0438\u0439 \u0440\u0430\u0437\u0434\u0435\u043B: \u042D\u0442\u043E \u0442\u0435\u0441\u0442\u043E\u0432\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 \u043D\u0430 \u0440\u0443\u0441\u0441\u043A\u043E\u043C \u044F\u0437\u044B\u043A\u0435 \u0434\u043B\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u0432\u0430\u043D\u0438\u044F \u044F\u0437\u044B\u043A\u043E\u0432.\n" +
        "English again: Another paragraph of English text for zone scanning tests.\n");
    }
  });

  test("Extension activates and commands are registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("lingofile.open"), "lingofile.open command should be registered");
    assert.ok(commands.includes("lingofile.openActive"), "lingofile.openActive command should be registered");
    assert.ok(commands.includes("lingofile.previewFile"), "lingofile.previewFile command should be registered");
    assert.ok(commands.includes("lingofile.analyseZones"), "lingofile.analyseZones command should be registered");
    assert.ok(commands.includes("lingofile.analyseZonesFull"), "lingofile.analyseZonesFull command should be registered");
    assert.ok(commands.includes("lingofile.saveMeta"), "lingofile.saveMeta command should be registered");
    assert.ok(commands.includes("lingofile.loadMeta"), "lingofile.loadMeta command should be registered");
  });

  test("Test files exist", () => {
    const fs = require("fs");
    assert.ok(fs.existsSync(path.join(testDir, "test.txt")));
    assert.ok(fs.existsSync(path.join(testDir, "large.txt")));
    assert.ok(fs.existsSync(path.join(testDir, "mixed.txt")));
  });
});
