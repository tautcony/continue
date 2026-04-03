import { describe, expect, it } from "vitest";
import {
  executeFindAndReplace,
  executeMultiFindAndReplace,
} from "./performReplace";
import { ContinueErrorReason } from "../../util/errors";

/**
 * Tests for line-ending normalization and indentation adjustment fixes
 * in the replace logic. These reproduce scenarios that caused silent
 * data corruption or unnecessary failures in production.
 */
describe("Line-ending normalization in find-and-replace", () => {
  it("should match \\n search against \\r\\n file content", () => {
    const fileContent = "line1\r\nline2\r\nline3\r\n";
    const oldString = "line1\nline2";
    const newString = "changed1\nchanged2";

    const result = executeFindAndReplace(
      fileContent,
      oldString,
      newString,
      false,
    );
    // Should preserve original \r\n line endings
    expect(result).toBe("changed1\r\nchanged2\r\nline3\r\n");
  });

  it("should match \\r\\n search against \\n file content", () => {
    const fileContent = "line1\nline2\nline3\n";
    const oldString = "line1\r\nline2";
    const newString = "changed1\r\nchanged2";

    const result = executeFindAndReplace(
      fileContent,
      oldString,
      newString,
      false,
    );
    // Should preserve original \n line endings
    expect(result).toBe("changed1\nchanged2\nline3\n");
  });

  it("should handle mixed line endings in replacement", () => {
    const fileContent = "a\r\nb\r\nc";
    const oldString = "b";
    const newString = "B";

    const result = executeFindAndReplace(
      fileContent,
      oldString,
      newString,
      false,
    );
    expect(result).toBe("a\r\nB\r\nc");
  });

  it("should handle replaceAll with \\r\\n files", () => {
    const fileContent = "foo\r\nbar\r\nfoo\r\n";
    const oldString = "foo";
    const newString = "baz";

    const result = executeFindAndReplace(
      fileContent,
      oldString,
      newString,
      true,
    );
    expect(result).toBe("baz\r\nbar\r\nbaz\r\n");
  });
});

describe("Indentation adjustment with new strategies", () => {
  it("should adjust indentation for lineTrimmedMatch", () => {
    const fileContent = "def foo():\n    x = 1\n    y = 2\n    return x + y\n";
    // LLM sends unindented search
    const oldString = "x = 1\ny = 2";
    const newString = "x = 10\ny = 20";
    const result = executeFindAndReplace(
      fileContent,
      oldString,
      newString,
      false,
    );
    expect(result).toBe(
      "def foo():\n    x = 10\n    y = 20\n    return x + y\n",
    );
  });

  it("should adjust indentation for indentationFlexibleMatch / lineTrimmedMatch", () => {
    const fileContent = "class Foo:\n    def bar(self):\n        return 42\n";
    // LLM sends with different indent level (2-space vs 4-space)
    const oldString = "def bar(self):\n  return 42";
    const newString = "def bar(self):\n  return 99";
    const result = executeFindAndReplace(
      fileContent,
      oldString,
      newString,
      false,
    );
    // Result should contain the replacement, with adjusted indentation
    expect(result).toContain("def bar(self):");
    expect(result).toContain("return 99");
    expect(result).toContain("class Foo:");
  });

  it("should preserve relative inner indentation in multi-line replacement", () => {
    const fileContent =
      "class Foo:\n    def bar(self):\n        if True:\n            x = 1\n";
    const oldString = "if True:\n    x = 1";
    const newString = "if True:\n    x = 1\n    y = 2";
    const result = executeFindAndReplace(
      fileContent,
      oldString,
      newString,
      false,
    );
    expect(result).toBe(
      "class Foo:\n    def bar(self):\n        if True:\n            x = 1\n            y = 2\n",
    );
  });

  it("should handle tab vs space mismatch with correct indentation", () => {
    const fileContent = "function foo() {\n\tconst x = 1;\n}\n";
    // LLM sends with leading spaces (not tabs)
    const oldString = "  const x = 1;";
    const newString = "  const x = 2;\n  const y = 3;";
    const result = executeFindAndReplace(
      fileContent,
      oldString,
      newString,
      false,
    );
    expect(result).toBe(
      "function foo() {\n\tconst x = 2;\n\tconst y = 3;\n}\n",
    );
  });
});

describe("Multi-edit with line-ending normalization", () => {
  it("should handle sequential edits on \\r\\n files", () => {
    const fileContent = "line1\r\nline2\r\nline3\r\n";
    const edits = [
      { old_string: "line1", new_string: "changed1" },
      { old_string: "line3", new_string: "changed3" },
    ];
    const result = executeMultiFindAndReplace(fileContent, edits);
    expect(result).toBe("changed1\r\nline2\r\nchanged3\r\n");
  });
});

describe("Edge cases that previously caused failures", () => {
  it("should handle LLM providing search content with extra blank line at end", () => {
    const fileContent = "if (x) {\n  return y;\n}";
    const oldString = "if (x) {\n  return y;\n}\n"; // Extra blank line
    const newString = "if (x) {\n  return z;\n}";

    const result = executeFindAndReplace(
      fileContent,
      oldString,
      newString,
      false,
    );
    expect(result).toBe("if (x) {\n  return z;\n}");
  });

  it("should handle LLM providing search with inconsistent line trimming", () => {
    const fileContent =
      "    function test() {\n        const a = 1;\n        const b = 2;\n    }";
    // LLM trims differently per line
    const oldString =
      "function test() {\n    const a = 1;\n    const b = 2;\n}";
    const newString =
      "function test() {\n    const a = 10;\n    const b = 20;\n}";

    const result = executeFindAndReplace(
      fileContent,
      oldString,
      newString,
      false,
    );
    // Should find via lineTrimmedMatch or indentationFlexibleMatch and adjust indentation
    expect(result).toContain("const a = 10");
    expect(result).toContain("const b = 20");
  });

  it("should throw descriptive error when no strategy matches", () => {
    const fileContent = "completely different content";
    const oldString = "nothing matching here at all";
    const newString = "replacement";

    expect(() => {
      executeFindAndReplace(fileContent, oldString, newString, false);
    }).toThrowError(
      expect.objectContaining({
        reason: ContinueErrorReason.FindAndReplaceOldStringNotFound,
      }),
    );
  });
});
