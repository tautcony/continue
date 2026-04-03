/**
 * Represents a basic match result with start and end character positions
 */
interface BasicMatchResult {
  /** The starting character index of the match in the file content */
  startIndex: number;
  /** The ending character index of the match in the file content (NOT inclusive - e.g. like slice)*/
  endIndex: number;
}

/**
 * Represents a match result with start and end character positions
 */
export interface SearchMatchResult extends BasicMatchResult {
  /** The name of the strategy that successfully matched */
  strategyName: string;
}

/**
 * Strategy function type for finding matches
 */
type MatchStrategy = (
  fileContent: string,
  searchContent: string,
) => BasicMatchResult | null;

/**
 * Normalize line endings to \n for consistent matching.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Detect the line ending style used in the text.
 */
export function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Convert all \n line endings to the specified ending.
 */
export function convertToLineEnding(
  text: string,
  ending: "\n" | "\r\n",
): string {
  if (ending === "\n") {
    return text;
  }
  return text.replace(/\n/g, "\r\n");
}

/**
 * Levenshtein distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") {
    return Math.max(a.length, b.length);
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

/**
 * Exact string matching strategy
 */
function exactMatch(
  fileContent: string,
  searchContent: string,
): BasicMatchResult | null {
  const exactIndex = fileContent.indexOf(searchContent);
  if (exactIndex !== -1) {
    return {
      startIndex: exactIndex,
      endIndex: exactIndex + searchContent.length,
    };
  }
  return null;
}

/**
 * Trimmed content matching strategy — trims the whole search string.
 */
function trimmedMatch(
  fileContent: string,
  searchContent: string,
): BasicMatchResult | null {
  const trimmedSearchContent = searchContent.trim();
  const trimmedIndex = fileContent.indexOf(trimmedSearchContent);
  if (trimmedIndex !== -1) {
    return {
      startIndex: trimmedIndex,
      endIndex: trimmedIndex + trimmedSearchContent.length,
    };
  }
  return null;
}

/**
 * Per-line trimmed matching: trims each line individually and compares.
 * Handles the common case where the LLM trims individual lines differently
 * from the file (e.g., trailing spaces, tab/space mix at line ends).
 */
function lineTrimmedMatch(
  fileContent: string,
  searchContent: string,
): BasicMatchResult | null {
  const fileLines = fileContent.split("\n");
  const searchLines = searchContent.split("\n");

  // Remove trailing empty line if present (LLMs often add one)
  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  if (searchLines.length === 0) {
    return null;
  }

  for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (fileLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }

    if (matches) {
      // Calculate character positions from line indices
      let startIndex = 0;
      for (let k = 0; k < i; k++) {
        startIndex += fileLines[k].length + 1; // +1 for \n
      }
      let endIndex = startIndex;
      for (let k = 0; k < searchLines.length; k++) {
        endIndex += fileLines[i + k].length;
        if (k < searchLines.length - 1) {
          endIndex += 1; // \n between lines
        }
      }
      return { startIndex, endIndex };
    }
  }
  return null;
}

/**
 * Case-insensitive matching strategy.
 * Uses the matched region length from the file content (not the search content)
 * to produce correct end positions.
 */
function caseInsensitiveMatch(
  fileContent: string,
  searchContent: string,
): BasicMatchResult | null {
  const lowerFileContent = fileContent.toLowerCase();
  const lowerSearchContent = searchContent.toLowerCase();
  const index = lowerFileContent.indexOf(lowerSearchContent);
  if (index !== -1) {
    return {
      startIndex: index,
      endIndex: index + lowerSearchContent.length,
    };
  }
  return null;
}

/**
 * Whitespace-ignored matching strategy.
 * Removes all whitespace from both content and search, then finds the match.
 */
function whitespaceIgnoredMatch(
  fileContent: string,
  searchContent: string,
): BasicMatchResult | null {
  const strippedFileContent = fileContent.replace(/\s/g, "");
  const strippedSearchContent = searchContent.replace(/\s/g, "");

  if (strippedSearchContent === "") {
    return null;
  }

  const strippedIndex = strippedFileContent.indexOf(strippedSearchContent);
  if (strippedIndex === -1) {
    return null;
  }

  // Map the stripped position back to the original file content
  let originalStartIndex = -1;
  let strippedCharCount = 0;

  for (let i = 0; i < fileContent.length; i++) {
    if (!/\s/.test(fileContent[i])) {
      if (strippedCharCount === strippedIndex) {
        originalStartIndex = i;
        break;
      }
      strippedCharCount++;
    }
  }

  if (originalStartIndex === -1) {
    return null;
  }

  let originalEndIndex = originalStartIndex;
  let matchedNonWhitespaceChars = 0;

  for (let i = originalStartIndex; i < fileContent.length; i++) {
    if (!/\s/.test(fileContent[i])) {
      matchedNonWhitespaceChars++;
      if (matchedNonWhitespaceChars === strippedSearchContent.length) {
        originalEndIndex = i + 1;
        break;
      }
    }
    originalEndIndex = i + 1;
  }

  return {
    startIndex: originalStartIndex,
    endIndex: originalEndIndex,
  };
}

/**
 * Block-anchor matching: matches when first and last lines match (after trim)
 * and middle lines are sufficiently similar via Levenshtein distance.
 * Handles the common case where the LLM slightly modifies middle lines.
 */
function blockAnchorMatch(
  fileContent: string,
  searchContent: string,
): BasicMatchResult | null {
  const fileLines = fileContent.split("\n");
  const searchLines = searchContent.split("\n");

  // Remove trailing empty line if present
  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  // Need at least 3 lines for meaningful anchor matching
  if (searchLines.length < 3) {
    return null;
  }

  const firstLineSearch = searchLines[0].trim();
  const lastLineSearch = searchLines[searchLines.length - 1].trim();

  if (firstLineSearch === "" || lastLineSearch === "") {
    return null;
  }

  // Collect candidate positions where both anchors match
  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].trim() !== firstLineSearch) {
      continue;
    }
    for (let j = i + 2; j < fileLines.length; j++) {
      if (fileLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j });
        break; // Match the first occurrence of last-line anchor after start
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const SINGLE_CANDIDATE_THRESHOLD = 0.0; // Accept any single match — anchors alone provide strong signal
  const MULTIPLE_CANDIDATES_THRESHOLD = 0.3; // Require moderate similarity to pick among ambiguous matches

  function scoreSimilarity(startLine: number, endLine: number): number {
    const actualBlockSize = endLine - startLine + 1;
    const searchBlockSize = searchLines.length;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);

    if (linesToCheck <= 0) {
      return 1.0; // No middle lines to compare — anchors alone are enough
    }

    let similarity = 0;
    for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
      const originalLine = fileLines[startLine + j].trim();
      const searchLine = searchLines[j].trim();
      const maxLen = Math.max(originalLine.length, searchLine.length);
      if (maxLen === 0) {
        continue;
      }
      const distance = levenshtein(originalLine, searchLine);
      similarity += (1 - distance / maxLen) / linesToCheck;
    }
    return similarity;
  }

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0];
    const similarity = scoreSimilarity(startLine, endLine);
    if (similarity >= SINGLE_CANDIDATE_THRESHOLD) {
      return linesToResult(fileLines, startLine, endLine);
    }
    return null;
  }

  // Multiple candidates: pick the best
  let bestMatch: { startLine: number; endLine: number } | null = null;
  let maxSimilarity = -1;

  for (const candidate of candidates) {
    const similarity = scoreSimilarity(candidate.startLine, candidate.endLine);
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  if (maxSimilarity >= MULTIPLE_CANDIDATES_THRESHOLD && bestMatch) {
    return linesToResult(fileLines, bestMatch.startLine, bestMatch.endLine);
  }

  return null;
}

/**
 * Indentation-flexible matching: strips the common leading indentation
 * from both the file block and search content before comparing.
 * Handles the common case where the LLM uses a different indentation level.
 */
function indentationFlexibleMatch(
  fileContent: string,
  searchContent: string,
): BasicMatchResult | null {
  const fileLines = fileContent.split("\n");
  const searchLines = searchContent.split("\n");

  // Remove trailing empty line if present
  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  if (searchLines.length === 0) {
    return null;
  }

  const normalizedSearch = removeCommonIndent(searchLines);

  for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
    const block = fileLines.slice(i, i + searchLines.length);
    const normalizedBlock = removeCommonIndent(block);
    if (normalizedBlock === normalizedSearch) {
      return linesToResult(fileLines, i, i + searchLines.length - 1);
    }
  }

  return null;
}

/**
 * Helper: convert line range to character positions.
 */
function linesToResult(
  fileLines: string[],
  startLine: number,
  endLine: number,
): BasicMatchResult {
  let startIndex = 0;
  for (let k = 0; k < startLine; k++) {
    startIndex += fileLines[k].length + 1;
  }
  let endIndex = startIndex;
  for (let k = startLine; k <= endLine; k++) {
    endIndex += fileLines[k].length;
    if (k < endLine) {
      endIndex += 1;
    }
  }
  return { startIndex, endIndex };
}

/**
 * Helper: strip the shortest common leading whitespace from all non-empty lines,
 * then join back into a string.
 */
function removeCommonIndent(lines: string[]): string {
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length === 0) {
    return lines.join("\n");
  }
  const minIndent = Math.min(
    ...nonEmptyLines.map((line) => {
      const m = line.match(/^(\s*)/);
      return m ? m[1].length : 0;
    }),
  );
  return lines
    .map((line) => (line.trim().length === 0 ? line : line.slice(minIndent)))
    .join("\n");
}

/**
 * Escape-normalized matching: unescapes common escape sequences in the search
 * content before matching. Handles the case where LLMs produce double-escaped
 * strings (e.g., `\\n` instead of a literal newline).
 *
 * Ported from OpenCode's EscapeNormalizedReplacer.
 */
function escapeNormalizedMatch(
  fileContent: string,
  searchContent: string,
): BasicMatchResult | null {
  const unescaped = unescapeString(searchContent);

  // Skip if unescaping didn't change anything
  if (unescaped === searchContent) {
    return null;
  }

  // Try direct match with unescaped search string
  const index = fileContent.indexOf(unescaped);
  if (index !== -1) {
    return { startIndex: index, endIndex: index + unescaped.length };
  }

  // Try unescaping both sides and matching blocks
  const fileLines = fileContent.split("\n");
  const searchLines = unescaped.split("\n");

  for (
    let i = 0;
    i <= fileLines.length - searchLines.length;
    i++
  ) {
    const block = fileLines.slice(i, i + searchLines.length).join("\n");
    if (unescapeString(block) === unescaped) {
      return linesToResult(fileLines, i, i + searchLines.length - 1);
    }
  }

  return null;
}

/**
 * Helper: unescape common escape sequences.
 */
function unescapeString(str: string): string {
  return str.replace(
    /\\(n|t|r|'|"|`|\\|\n|\$)/g,
    (match, capturedChar: string) => {
      switch (capturedChar) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "'":
          return "'";
        case '"':
          return '"';
        case "`":
          return "`";
        case "\\":
          return "\\";
        case "\n":
          return "\n";
        case "$":
          return "$";
        default:
          return match;
      }
    },
  );
}

/**
 * Whitespace-normalized matching: normalizes runs of whitespace to a single space,
 * then matches. More precise than whitespaceIgnoredMatch (which strips ALL whitespace).
 *
 * Handles three modes:
 * 1. Full line match
 * 2. Substring match within a single line (uses regex)
 * 3. Multi-line block match
 *
 * Ported from OpenCode's WhitespaceNormalizedReplacer.
 */
function whitespaceNormalizedMatch(
  fileContent: string,
  searchContent: string,
): BasicMatchResult | null {
  const normalizeWhitespace = (text: string) =>
    text.replace(/\s+/g, " ").trim();
  const normalizedSearch = normalizeWhitespace(searchContent);

  if (normalizedSearch === "") {
    return null;
  }

  const fileLines = fileContent.split("\n");

  // Mode 1 & 2: Single line matches
  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i];

    // Full line match
    if (normalizeWhitespace(line) === normalizedSearch) {
      return linesToResult(fileLines, i, i);
    }

    // Substring match
    const normalizedLine = normalizeWhitespace(line);
    if (normalizedLine.includes(normalizedSearch)) {
      // Use regex to find the actual substring in the original line
      const words = searchContent
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0);
      if (words.length > 0) {
        const pattern = words
          .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("\\s+");
        try {
          const regex = new RegExp(pattern);
          const match = line.match(regex);
          if (match && match.index !== undefined) {
            const lineStart = linesToResult(fileLines, i, i).startIndex;
            return {
              startIndex: lineStart + match.index,
              endIndex: lineStart + match.index + match[0].length,
            };
          }
        } catch {
          // Invalid regex pattern, skip
        }
      }
    }
  }

  // Mode 3: Multi-line block match
  const searchLines = searchContent.split("\n");
  if (searchLines.length > 1) {
    for (
      let i = 0;
      i <= fileLines.length - searchLines.length;
      i++
    ) {
      const block = fileLines.slice(i, i + searchLines.length);
      if (normalizeWhitespace(block.join("\n")) === normalizedSearch) {
        return linesToResult(fileLines, i, i + searchLines.length - 1);
      }
    }
  }

  return null;
}

/**
 * Context-aware matching: matches blocks where the first and last lines match
 * (after trimming) and at least 50% of middle lines match exactly.
 * Requires the block size to exactly equal the search size.
 *
 * Complementary to blockAnchorMatch which uses Levenshtein distance and allows
 * different block sizes.
 *
 * Ported from OpenCode's ContextAwareReplacer.
 */
function contextAwareMatch(
  fileContent: string,
  searchContent: string,
): BasicMatchResult | null {
  const fileLines = fileContent.split("\n");
  const searchLines = searchContent.split("\n");

  // Remove trailing empty line
  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  // Need at least 3 lines for context-aware matching
  if (searchLines.length < 3) {
    return null;
  }

  const firstLine = searchLines[0].trim();
  const lastLine = searchLines[searchLines.length - 1].trim();

  if (firstLine === "" || lastLine === "") {
    return null;
  }

  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].trim() !== firstLine) {
      continue;
    }

    // Look for matching last line
    for (let j = i + 2; j < fileLines.length; j++) {
      if (fileLines[j].trim() !== lastLine) {
        continue;
      }

      // Found candidate — check if block size matches
      const blockLines = fileLines.slice(i, j + 1);
      if (blockLines.length !== searchLines.length) {
        break; // Only match first occurrence of last line
      }

      // Check middle line similarity (≥50% exact match after trim)
      let matchingLines = 0;
      let totalNonEmptyLines = 0;

      for (let k = 1; k < blockLines.length - 1; k++) {
        const blockLine = blockLines[k].trim();
        const searchLine = searchLines[k].trim();

        if (blockLine.length > 0 || searchLine.length > 0) {
          totalNonEmptyLines++;
          if (blockLine === searchLine) {
            matchingLines++;
          }
        }
      }

      if (
        totalNonEmptyLines === 0 ||
        matchingLines / totalNonEmptyLines >= 0.5
      ) {
        return linesToResult(fileLines, i, j);
      }

      break; // Only match first occurrence
    }
  }

  return null;
}

/**
 * Ordered list of matching strategies to try with their names.
 *
 * Order rationale:
 * 1. exactMatch — fastest, no transformation
 * 2. trimmedMatch — whole-string trim
 * 3. lineTrimmedMatch — per-line trim (handles trailing spaces per line)
 * 4. caseInsensitiveMatch — case folding
 * 5. indentationFlexibleMatch — different indent level
 * 6. escapeNormalizedMatch — unescape sequences (\\n → \n)
 * 7. whitespaceNormalizedMatch — normalize \s+ to single space (replaces whitespaceIgnoredMatch)
 * 8. whitespaceIgnoredMatch — strips all whitespace (most aggressive whitespace fallback)
 * 9. blockAnchorMatch — first/last line anchors with Levenshtein (most tolerant)
 * 10. contextAwareMatch — first/last line anchors with 50% exact middle match
 */
const matchingStrategies: Array<{ strategy: MatchStrategy; name: string }> = [
  { strategy: exactMatch, name: "exactMatch" },
  { strategy: trimmedMatch, name: "trimmedMatch" },
  { strategy: lineTrimmedMatch, name: "lineTrimmedMatch" },
  { strategy: caseInsensitiveMatch, name: "caseInsensitiveMatch" },
  { strategy: indentationFlexibleMatch, name: "indentationFlexibleMatch" },
  { strategy: escapeNormalizedMatch, name: "escapeNormalizedMatch" },
  { strategy: whitespaceNormalizedMatch, name: "whitespaceNormalizedMatch" },
  { strategy: whitespaceIgnoredMatch, name: "whitespaceIgnoredMatch" },
  { strategy: blockAnchorMatch, name: "blockAnchorMatch" },
  { strategy: contextAwareMatch, name: "contextAwareMatch" },
];

/**
 * Find the exact match position for search content in file content.
 * Uses multiple matching strategies in order of preference.
 *
 * Matching Strategy:
 * 1. If search content is empty, matches at the beginning of file (position 0)
 * 2. Try each matching strategy in order until one succeeds
 *
 * @param fileContent - The complete content of the file to search in
 * @param searchContent - The content to search for
 * @param config - Configuration options for matching behavior
 * @returns Match result with character positions, or null if no match found
 */
export function findSearchMatch(
  fileContent: string,
  searchContent: string,
): SearchMatchResult | null {
  const trimmedSearchContent = searchContent.trim();

  if (trimmedSearchContent === "") {
    // Empty search content matches the beginning of the file
    return { startIndex: 0, endIndex: 0, strategyName: "emptySearch" };
  }

  // Try each matching strategy in order
  for (const { strategy, name } of matchingStrategies) {
    const result = strategy(fileContent, searchContent);
    if (result !== null) {
      return { ...result, strategyName: name };
    }
  }

  return null;
}

/**
 * Find all matches for search content in file content.
 * Uses the same matching strategies as findSearchMatch, applied iteratively.
 *
 * @param fileContent - The complete content of the file to search in
 * @param searchContent - The content to search for
 * @returns Array of match results with character positions, empty array if no matches found
 */
export function findSearchMatches(
  fileContent: string,
  searchContent: string,
): SearchMatchResult[] {
  const matches: SearchMatchResult[] = [];

  // Special case: empty search string always matches at position 0
  if (searchContent.trim() === "") {
    return [{ startIndex: 0, endIndex: 0, strategyName: "emptySearch" }];
  }

  let remainingContent = fileContent;
  let currentOffset = 0;

  while (remainingContent.length > 0) {
    const match = findSearchMatch(remainingContent, searchContent);

    if (match === null) {
      break;
    }

    // Adjust match positions to account for the current offset
    const adjustedMatch: SearchMatchResult = {
      startIndex: match.startIndex + currentOffset,
      endIndex: match.endIndex + currentOffset,
      strategyName: match.strategyName,
    };

    // Prevent infinite loops by ensuring we're making progress
    // If the new match starts at or before the last match's start position, break
    if (
      matches.length > 0 &&
      adjustedMatch.startIndex <= matches[matches.length - 1].startIndex
    ) {
      break;
    }

    matches.push(adjustedMatch);

    // Update offset and truncate content after the current match
    currentOffset = adjustedMatch.endIndex;
    remainingContent = fileContent.slice(currentOffset);
  }

  return matches;
}
