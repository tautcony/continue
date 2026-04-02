import * as fs from "fs";

import { ContinueError, ContinueErrorReason } from "core/util/errors.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  calculateLinesOfCodeDiff,
  getLanguageFromFilePath,
} from "../telemetry/utils.js";

import { editTool } from "./edit.js";
import { markFileAsRead, readFilesSet } from "./readFile.js";
import { generateDiff } from "./writeFile.js";

// Mock the dependencies
vi.mock("../telemetry/telemetryService.js");
vi.mock("../telemetry/utils.js");
vi.mock("./writeFile.js");
vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    realpathSync: vi.fn(),
  };
});

describe("editTool", () => {
  const testFilePath = "/tmp/test-edit-file.txt";
  const originalContent = "Hello world\nThis is a test file\nGoodbye world";

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock fs functions to simulate file operations
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(originalContent);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.realpathSync).mockImplementation((path) => path.toString());

    // Setup utility mocks with proper return values
    vi.mocked(calculateLinesOfCodeDiff).mockReturnValue({
      added: 1,
      removed: 0,
    });
    vi.mocked(getLanguageFromFilePath).mockReturnValue("javascript");
    vi.mocked(generateDiff).mockReturnValue("mocked diff");
  });

  afterEach(() => {
    vi.clearAllMocks();
    readFilesSet.clear();
  });

  describe("preprocess", () => {
    it("should throw error if file has not been read", async () => {
      const args = {
        file_path: testFilePath,
        old_string: "Hello world",
        new_string: "Hi there",
      };

      const error = await editTool.preprocess!(args).catch((e) => e);
      expect(error).toBeInstanceOf(ContinueError);
      expect(error.reason).toBe(ContinueErrorReason.EditToolFileNotRead);
    });

    it("should throw error if file does not exist", async () => {
      const nonExistentFile = "/tmp/non-existent-file.txt";
      markFileAsRead(nonExistentFile);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const args = {
        file_path: nonExistentFile,
        old_string: "Hello",
        new_string: "Hi",
      };

      const error = await editTool.preprocess!(args).catch((e) => e);
      expect(error).toBeInstanceOf(ContinueError);
      expect(error.reason).toBe(ContinueErrorReason.FileNotFound);
    });

    it("should throw error if old_string is not found", async () => {
      markFileAsRead(testFilePath);
      vi.mocked(fs.readFileSync).mockReturnValue("Different content");

      const args = {
        file_path: testFilePath,
        old_string: "Not found",
        new_string: "Hi there",
      };

      const error = await editTool.preprocess!(args).catch((e) => e);
      expect(error).toBeInstanceOf(ContinueError);
      expect(error.reason).toBe(
        ContinueErrorReason.FindAndReplaceOldStringNotFound,
      );
    });

    it("should throw error if old_string appears multiple times and replace_all is false", async () => {
      markFileAsRead(testFilePath);

      const args = {
        file_path: testFilePath,
        old_string: "world",
        new_string: "universe",
        replace_all: false,
      };

      const error = await editTool.preprocess!(args).catch((e) => e);
      expect(error).toBeInstanceOf(ContinueError);
      expect(error.reason).toBe(
        ContinueErrorReason.FindAndReplaceMultipleOccurrences,
      );
    });

    it("should throw error if old_string and new_string are the same", async () => {
      markFileAsRead(testFilePath);

      const args = {
        file_path: testFilePath,
        old_string: "Hello world",
        new_string: "Hello world",
      };

      const error = await editTool.preprocess!(args).catch((e) => e);
      expect(error).toBeInstanceOf(ContinueError);
      expect(error.reason).toBe(
        ContinueErrorReason.FindAndReplaceIdenticalOldAndNewStrings,
      );
    });

    it("should successfully preprocess valid single replacement", async () => {
      markFileAsRead(testFilePath);

      const args = {
        file_path: testFilePath,
        old_string: "Hello world",
        new_string: "Hi there",
      };

      const result = await editTool.preprocess!(args);

      expect(result.args).toEqual({
        resolvedPath: testFilePath,
        newContent: "Hi there\nThis is a test file\nGoodbye world",
        oldContent: originalContent,
      });
      expect(result.preview).toHaveLength(2);
      expect(result.preview?.[0]).toEqual({
        type: "text",
        content: "Will make the following changes:",
      });
      expect(result.preview?.[1]).toEqual({
        type: "diff",
        content: "mocked diff",
      });
    });

    it("should successfully preprocess replace_all", async () => {
      markFileAsRead(testFilePath);

      const args = {
        file_path: testFilePath,
        old_string: "world",
        new_string: "universe",
        replace_all: true,
      };

      const result = await editTool.preprocess!(args);

      expect(result.args.newContent).toBe(
        "Hello universe\nThis is a test file\nGoodbye universe",
      );
    });
  });

  describe("run", () => {
    it("should successfully write file and return success message", async () => {
      const newContent = "Hi there\nThis is a test file\nGoodbye world";
      const args = {
        resolvedPath: testFilePath,
        newContent,
        oldContent: originalContent,
      };

      const result = await editTool.run(args);

      expect(result).toBe(
        `Successfully edited ${testFilePath}\nDiff:\nmocked diff`,
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        testFilePath,
        newContent,
        "utf-8",
      );
    });

    it("should throw error if file write fails", async () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error("Write failed");
      });

      const args = {
        resolvedPath: testFilePath,
        newContent: "new content",
        oldContent: originalContent,
      };

      const error = await editTool.run(args).catch((e) => e);
      expect(error).toBeInstanceOf(ContinueError);
      expect(error.reason).toBe(ContinueErrorReason.FileWriteError);
    });
  });

  describe("markFileAsRead", () => {
    it("should allow editing after marking file as read", async () => {
      markFileAsRead(testFilePath);

      const args = {
        file_path: testFilePath,
        old_string: "Hello world",
        new_string: "Hi there",
      };

      const result = await editTool.preprocess!(args);
      expect(result.args.newContent).toContain("Hi there");
    });
  });

  describe("regression: Bug 1 - existsSync must run before realpathSync", () => {
    it("should return ContinueError(FileNotFound) and NOT call realpathSync when file does not exist", async () => {
      // This reproduces the original bug where realpathSync was called first and
      // threw an opaque ENOENT instead of a clean FileNotFound ContinueError.
      markFileAsRead(testFilePath);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // Make realpathSync throw ENOENT like the real implementation would
      vi.mocked(fs.realpathSync).mockImplementation(() => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), {
          code: "ENOENT",
        });
      });

      const args = {
        file_path: testFilePath,
        old_string: "Hello world",
        new_string: "Hi there",
      };

      const error = await editTool.preprocess!(args).catch((e) => e);

      // Must be a ContinueError with FileNotFound, not a raw ENOENT
      expect(error).toBeInstanceOf(ContinueError);
      expect(error.reason).toBe(ContinueErrorReason.FileNotFound);
      expect(error.message).toContain("does not exist");

      // realpathSync must NOT have been called (existsSync gates it)
      expect(fs.realpathSync).not.toHaveBeenCalled();
    });
  });

  describe("regression: Bug 2 - parallel Read+Edit in same batch", () => {
    it("should succeed when readFileTool.preprocess has been called first in the same batch", async () => {
      // Import readFileTool here to simulate the parallel-batch scenario:
      //   1. readFileTool.preprocess() runs (marks file as read)
      //   2. editTool.preprocess() runs (checks readFilesSet)
      // Both happen before any run() is called, just like in executeStreamedToolCalls.
      const { readFileTool } = await import("./readFile.js");

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.realpathSync).mockImplementation((p) => p.toString());

      // Step 1: Read's preprocess - this now calls markFileAsRead internally,
      // simulating the "parallel batch" where all preprocess calls run first.
      await readFileTool.preprocess!({ filepath: testFilePath });

      // Step 2: Edit's preprocess in the same batch — should now succeed
      const args = {
        file_path: testFilePath,
        old_string: "Hello world",
        new_string: "Hi there",
      };

      const result = await editTool.preprocess!(args);
      expect(result.args.newContent).toContain("Hi there");
    });
  });
});
