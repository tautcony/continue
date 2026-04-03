import { describe, expect, it } from "vitest";
import { findSearchMatch } from "./findSearchMatch";
import { executeFindAndReplace } from "./performReplace";

/**
 * Tests for strategies ported from OpenCode that were still missing
 * after the first PR: escapeNormalizedMatch, whitespaceNormalizedMatch,
 * contextAwareMatch.
 */

describe("escapeNormalizedMatch", () => {
  it("should match when LLM provides \\\\n instead of literal newline", () => {
    const fileContent = 'console.log("hello\\nworld")';
    const searchContent = 'console.log("hello\\\\nworld")';
    // The LLM double-escapes: \\n in the search should unescape to \n
    const result = findSearchMatch(fileContent, searchContent);
    expect(result).not.toBeNull();
    expect(result!.strategyName).toBe("escapeNormalizedMatch");
  });

  it("should match when LLM escapes quotes", () => {
    const fileContent = "const x = 'hello'";
    const searchContent = "const x = \\'hello\\'";
    const result = findSearchMatch(fileContent, searchContent);
    expect(result).not.toBeNull();
    expect(result!.strategyName).toBe("escapeNormalizedMatch");
  });

  it("should match when LLM escapes tabs", () => {
    const fileContent = "const x = 'hello\tworld'";
    const searchContent = "const x = 'hello\\tworld'";
    const result = findSearchMatch(fileContent, searchContent);
    expect(result).not.toBeNull();
    expect(result!.strategyName).toBe("escapeNormalizedMatch");
  });

  it("should not match when unescaping doesn't help", () => {
    const fileContent = "const x = 1";
    const searchContent = "const y = 2";
    const result = findSearchMatch(fileContent, searchContent);
    expect(result).toBeNull();
  });

  it("should skip when search has no escape sequences", () => {
    const fileContent = "const x = 1";
    const searchContent = "const x = 1";
    const result = findSearchMatch(fileContent, searchContent);
    // Should match via exactMatch, not escapeNormalizedMatch
    expect(result!.strategyName).toBe("exactMatch");
  });

  it("should handle escaped dollar signs", () => {
    const fileContent = "echo $HOME";
    const searchContent = "echo \\$HOME";
    const result = findSearchMatch(fileContent, searchContent);
    expect(result).not.toBeNull();
    expect(result!.strategyName).toBe("escapeNormalizedMatch");
  });
});

describe("whitespaceNormalizedMatch", () => {
  it("should match when LLM collapses multiple spaces to one", () => {
    const fileContent = "if (  x  &&  y  ) {";
    const searchContent = "if ( x && y ) {";
    const result = findSearchMatch(fileContent, searchContent);
    expect(result).not.toBeNull();
    expect(result!.strategyName).toBe("whitespaceNormalizedMatch");
    expect(
      fileContent.slice(result!.startIndex, result!.endIndex),
    ).toBe("if (  x  &&  y  ) {");
  });

  it("should match substring within a line", () => {
    const fileContent = "    const   result  =  foo(  x  )  ;";
    const searchContent = "foo( x )";
    const result = findSearchMatch(fileContent, searchContent);
    expect(result).not.toBeNull();
    // The matched substring should be the actual text from the file
    expect(result!.startIndex).toBeGreaterThan(0);
    const matched = fileContent.slice(result!.startIndex, result!.endIndex);
    expect(matched).toContain("foo");
    expect(matched).toContain("x");
  });

  it("should match multi-line block with normalized whitespace", () => {
    const fileContent = "function  foo()  {\n  return   42;\n}";
    const searchContent = "function foo() {\nreturn 42;\n}";
    const result = findSearchMatch(fileContent, searchContent);
    expect(result).not.toBeNull();
    // Could be lineTrimmedMatch or whitespaceNormalizedMatch
    expect(result).not.toBeNull();
  });

  it("should not match when content actually differs", () => {
    const fileContent = "if (x && y) {";
    const searchContent = "if (x || y) {";
    const result = findSearchMatch(fileContent, searchContent);
    expect(result).toBeNull();
  });

  it("should handle tab vs space normalization", () => {
    const fileContent = "const\tx\t=\t1;";
    const searchContent = "const x = 1;";
    const result = findSearchMatch(fileContent, searchContent);
    expect(result).not.toBeNull();
    // lineTrimmedMatch or whitespaceNormalizedMatch should catch this
    expect(["lineTrimmedMatch", "whitespaceNormalizedMatch"]).toContain(
      result!.strategyName,
    );
  });
});

describe("contextAwareMatch", () => {
  it("should match block with same anchors and ≥50% middle match", () => {
    const fileContent = [
      "function foo() {",
      "  const x = 1;",
      "  const y = 2;",
      "  const z = 3;",
      "  return x + y + z;",
      "}",
    ].join("\n");
    // LLM modifies one middle line (const z = 3 → const z = 99)
    // but other middle lines match exactly
    const searchContent = [
      "function foo() {",
      "  const x = 1;",
      "  const y = 2;",
      "  const z = 99;",
      "  return x + y + z;",
      "}",
    ].join("\n");

    const result = findSearchMatch(fileContent, searchContent);
    expect(result).not.toBeNull();
    // Should be caught by one of the fuzzy strategies
    expect(
      ["blockAnchorMatch", "contextAwareMatch"].includes(result!.strategyName),
    ).toBe(true);
    expect(fileContent.slice(result!.startIndex, result!.endIndex)).toBe(
      fileContent,
    );
  });

  it("should not match when <50% of middle lines match", () => {
    const fileContent = [
      "function foo() {",
      "  const x = 1;",
      "  const y = 2;",
      "  return x + y;",
      "}",
    ].join("\n");
    // All middle lines are completely different
    const searchContent = [
      "function foo() {",
      "  let a = 10;",
      "  let b = 20;",
      "  return a * b;",
      "}",
    ].join("\n");

    const result = findSearchMatch(fileContent, searchContent);
    // blockAnchorMatch might still catch this (it uses Levenshtein with 0.0 threshold for single candidate)
    // contextAwareMatch would reject it (0/3 = 0% < 50%)
    if (result) {
      expect(result.strategyName).not.toBe("contextAwareMatch");
    }
  });

  it("should require exactly matching block size", () => {
    const fileContent = [
      "if (x) {",
      "  doA();",
      "  doB();",
      "  doC();",
      "}",
    ].join("\n");
    // Search has different number of lines (extra line)
    const searchContent = [
      "if (x) {",
      "  doA();",
      "  doB();",
      "  doC();",
      "  doD();",
      "}",
    ].join("\n");

    const result = findSearchMatch(fileContent, searchContent);
    // contextAwareMatch should not match because block sizes differ
    if (result) {
      expect(result.strategyName).not.toBe("contextAwareMatch");
    }
  });
});

describe("Find-and-replace with new strategies", () => {
  it("should use escapeNormalizedMatch for replacement", () => {
    const fileContent = 'const msg = "hello\\nworld";';
    const oldString = 'const msg = "hello\\\\nworld";';
    const newString = 'const msg = "hello\\\\n\\\\nworld";';

    const result = executeFindAndReplace(
      fileContent,
      oldString,
      newString,
      false,
    );
    expect(result).toContain("hello");
    expect(result).toContain("world");
  });

  it("should use whitespaceNormalizedMatch for replacement", () => {
    const fileContent = "if (  x  &&  y  ) { return true; }";
    const oldString = "if ( x && y ) { return true; }";
    const newString = "if (x && y) { return false; }";

    const result = executeFindAndReplace(
      fileContent,
      oldString,
      newString,
      false,
    );
    expect(result).toContain("return false");
  });

  it("should use contextAwareMatch for replacement when other strategies fail", () => {
    const fileContent = [
      "function calc() {",
      "  const x = 10;",
      "  const y = 20;",
      "  return x + y;",
      "}",
      "",
      "function other() {",
      "  return 42;",
      "}",
    ].join("\n");
    // LLM slightly modifies middle but anchors match
    const oldString = [
      "function calc() {",
      "  const x = 10;",
      "  const y = 99;",
      "  return x + y;",
      "}",
    ].join("\n");
    const newString = [
      "function calc() {",
      "  const x = 100;",
      "  const y = 200;",
      "  return x + y;",
      "}",
    ].join("\n");

    const result = executeFindAndReplace(
      fileContent,
      oldString,
      newString,
      false,
    );
    expect(result).toContain("const x = 100");
    expect(result).toContain("const y = 200");
    expect(result).toContain("function other");
  });
});
