import { EditOperation } from "../../tools/definitions/multiEdit";
import { ContinueError, ContinueErrorReason } from "../../util/errors";
import {
  SearchMatchResult,
  convertToLineEnding,
  detectLineEnding,
  findSearchMatches,
  normalizeLineEndings,
} from "./findSearchMatch";

/**
 * Get the leading whitespace of the first non-empty line in a string.
 */
function getLeadingIndent(text: string): string {
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.trim().length > 0) {
      const match = line.match(/^(\s*)/);
      return match ? match[1] : "";
    }
  }
  return "";
}

/**
 * Get the indentation of the file line containing a given character position.
 */
function getLineIndentAtPosition(
  fileContent: string,
  position: number,
): string {
  const lineStart = fileContent.lastIndexOf("\n", position - 1) + 1;
  const lineEnd = fileContent.indexOf("\n", lineStart);
  const line = fileContent.substring(
    lineStart,
    lineEnd === -1 ? fileContent.length : lineEnd,
  );
  const match = line.match(/^(\s*)/);
  return match ? match[1] : "";
}

/**
 * When a fuzzy match strategy (trimmedMatch, lineTrimmedMatch, etc.)
 * finds a match, the indentation of the matched region in the file may
 * differ from the indentation in the search string provided by the LLM.
 * This function adjusts newString so its indentation is relative to the
 * actual matched text in the file rather than the LLM-provided oldString.
 */
function adjustReplacementIndentation(
  fileContent: string,
  match: SearchMatchResult,
  oldString: string,
  newString: string,
): string {
  if (
    match.strategyName === "exactMatch" ||
    match.strategyName === "emptySearch"
  ) {
    return newString;
  }

  const matchedIndent = getLineIndentAtPosition(fileContent, match.startIndex);
  const oldIndent = getLeadingIndent(oldString);

  if (matchedIndent === oldIndent) {
    return newString;
  }

  const lines = newString.split("\n");
  const adjusted = lines.map((line, index) => {
    if (line.trim().length === 0) {
      return line;
    }
    if (index === 0) {
      // First line: check if the position in the file is at the start of a line.
      // If so, the replacement needs the full matched indentation.
      const charBefore =
        match.startIndex > 0 ? fileContent[match.startIndex - 1] : "\n";
      if (charBefore === "\n" || match.startIndex === 0) {
        // Start of line — apply full matched indent, stripping old indent
        if (oldIndent && line.startsWith(oldIndent)) {
          return matchedIndent + line.slice(oldIndent.length);
        }
        return matchedIndent + line;
      }
      // Mid-line insertion — file content before startIndex already provides
      // indentation, so strip the old indent rather than adding new
      if (oldIndent && line.startsWith(oldIndent)) {
        return line.slice(oldIndent.length);
      }
      return line;
    }
    // Subsequent lines: replace oldIndent prefix with matchedIndent
    if (oldIndent && line.startsWith(oldIndent)) {
      return matchedIndent + line.slice(oldIndent.length);
    }
    // If old indent is empty, prepend matched indent
    if (oldIndent === "") {
      return matchedIndent + line;
    }
    return line;
  });
  return adjusted.join("\n");
}

export function executeFindAndReplace(
  fileContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  editIndex = 0,
): string {
  // Normalize line endings for consistent matching, then restore afterwards
  const originalEnding = detectLineEnding(fileContent);
  const normalizedFileContent = normalizeLineEndings(fileContent);
  const normalizedOldString = normalizeLineEndings(oldString);
  const normalizedNewString = normalizeLineEndings(newString);

  const matches = findSearchMatches(normalizedFileContent, normalizedOldString);

  if (matches.length === 0) {
    throw new ContinueError(
      ContinueErrorReason.FindAndReplaceOldStringNotFound,
      `Edit at index ${editIndex}: string not found in file: "${oldString}"`,
    );
  }

  let result: string;

  if (replaceAll) {
    // Apply replacements in reverse order to maintain correct positions
    result = normalizedFileContent;
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const adjustedNew = adjustReplacementIndentation(
        result,
        match,
        normalizedOldString,
        normalizedNewString,
      );
      result =
        result.substring(0, match.startIndex) +
        adjustedNew +
        result.substring(match.endIndex);
    }
  } else {
    // For single replacement, check for multiple matches first
    if (matches.length > 1) {
      throw new ContinueError(
        ContinueErrorReason.FindAndReplaceMultipleOccurrences,
        `Edit at index ${editIndex}: String "${oldString}" appears ${matches.length} times in the file. Either provide a more specific string with surrounding context to make it unique, or use replace_all=true to replace all occurrences.`,
      );
    }

    // Apply single replacement
    const match = matches[0];
    const adjustedNew = adjustReplacementIndentation(
      normalizedFileContent,
      match,
      normalizedOldString,
      normalizedNewString,
    );
    result =
      normalizedFileContent.substring(0, match.startIndex) +
      adjustedNew +
      normalizedFileContent.substring(match.endIndex);
  }

  // Restore original line ending style
  return convertToLineEnding(result, originalEnding);
}

export function executeMultiFindAndReplace(
  fileContent: string,
  edits: EditOperation[],
): string {
  let result = fileContent;

  // Apply edits in sequence
  for (let editIndex = 0; editIndex < edits.length; editIndex++) {
    const edit = edits[editIndex];
    result = executeFindAndReplace(
      result,
      edit.old_string,
      edit.new_string,
      edit.replace_all ?? false,
      editIndex,
    );
  }

  return result;
}
