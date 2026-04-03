import { describe, expect, it } from "vitest";
import { ToolCallDelta } from "..";
import { parseToolCallArgsOrThrow, safeParseToolCallArgs } from "./parseArgs";
import { truncateToolOutput } from "../util/messageContent";

describe("parseToolCallArgsOrThrow", () => {
  it("should parse valid JSON arguments", () => {
    const toolCall: ToolCallDelta = {
      id: "1",
      function: {
        name: "readFile",
        arguments: '{"filepath": "/tmp/test.ts"}',
      },
    };
    const result = parseToolCallArgsOrThrow(toolCall);
    expect(result).toEqual({ filepath: "/tmp/test.ts" });
  });

  it("should return pre-parsed object arguments directly", () => {
    const toolCall: ToolCallDelta = {
      id: "1",
      function: {
        name: "readFile",
        arguments: { filepath: "/tmp/test.ts" } as any,
      },
    };
    const result = parseToolCallArgsOrThrow(toolCall);
    expect(result).toEqual({ filepath: "/tmp/test.ts" });
  });

  it("should throw descriptive error for invalid JSON", () => {
    const toolCall: ToolCallDelta = {
      id: "1",
      function: {
        name: "editFile",
        arguments: '{"filepath": "/tmp/test.ts", invalid',
      },
    };
    expect(() => parseToolCallArgsOrThrow(toolCall)).toThrowError(
      /Failed to parse tool call arguments for "editFile"/,
    );
    expect(() => parseToolCallArgsOrThrow(toolCall)).toThrowError(
      /Ensure arguments are valid JSON/,
    );
  });

  it("should include raw arguments in error for debugging", () => {
    const toolCall: ToolCallDelta = {
      id: "1",
      function: {
        name: "editFile",
        arguments: "not json at all",
      },
    };
    expect(() => parseToolCallArgsOrThrow(toolCall)).toThrowError(
      /not json at all/,
    );
  });

  it("should truncate very long raw arguments in error message", () => {
    const longArgs = "x".repeat(1000);
    const toolCall: ToolCallDelta = {
      id: "1",
      function: {
        name: "editFile",
        arguments: longArgs,
      },
    };
    try {
      parseToolCallArgsOrThrow(toolCall);
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message.length).toBeLessThan(700);
      expect(e.message).toContain("...");
    }
  });

  it("should throw for empty arguments", () => {
    const toolCall: ToolCallDelta = {
      id: "1",
      function: {
        name: "readFile",
        arguments: "",
      },
    };
    expect(() => parseToolCallArgsOrThrow(toolCall)).toThrowError(
      /was called with no arguments/,
    );
  });

  it("should throw for undefined arguments", () => {
    const toolCall: ToolCallDelta = {
      id: "1",
      function: {
        name: "readFile",
        arguments: undefined,
      },
    };
    expect(() => parseToolCallArgsOrThrow(toolCall)).toThrowError(
      /was called with no arguments/,
    );
  });
});

describe("safeParseToolCallArgs backward compatibility", () => {
  it("should still return empty object for invalid JSON (not throw)", () => {
    const toolCall: ToolCallDelta = {
      id: "1",
      function: {
        name: "editFile",
        arguments: "not json",
      },
    };
    // safeParseToolCallArgs should NOT throw — used by LLM providers
    const result = safeParseToolCallArgs(toolCall);
    expect(result).toEqual({});
  });
});

describe("truncateToolOutput", () => {
  it("should not truncate small output", () => {
    const output = "line1\nline2\nline3";
    expect(truncateToolOutput(output)).toBe(output);
  });

  it("should truncate output exceeding line limit", () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const output = lines.join("\n");
    const result = truncateToolOutput(output);

    expect(result).toContain("truncated");
    expect(result).toContain("read_file_range");
    expect(result).toContain("grep_search");
    // Should have fewer lines than original
    expect(result.split("\n").length).toBeLessThan(lines.length);
  });

  it("should truncate output exceeding byte limit", () => {
    // Create output that's small in lines but large in bytes
    const largeLine = "x".repeat(10000);
    const lines = Array.from({ length: 10 }, () => largeLine);
    const output = lines.join("\n");
    const result = truncateToolOutput(output);

    expect(result).toContain("truncated");
    expect(result.length).toBeLessThan(output.length);
  });

  it("should include truncation stats in message", () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const output = lines.join("\n");
    const result = truncateToolOutput(output);

    // Should mention how many lines were truncated
    expect(result).toMatch(/truncated \d+ of 3000 lines/);
  });
});
