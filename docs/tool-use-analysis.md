# Tool Use: Continue vs OpenCode Comparison

Analysis of why Continue's tool use (file editing, reading, etc.) fails more often than OpenCode's under the same model, and what to fix.

## Core Problem

Continue's find-and-replace matching for file edits is brittle. When an LLM provides `old_string` with minor whitespace, indentation, or line-ending differences from the actual file content, the edit fails outright. OpenCode uses a cascading chain of fallback replacers (9 strategies) that tolerate common LLM errors. Continue has only 4 strategies and its fuzzy matcher is disabled due to a known bug.

The result: identical models succeed more often with OpenCode because OpenCode's matching is more forgiving.

## Issue 1: Insufficient Matching Fallbacks

### Continue (4 strategies, fuzzy disabled)

```
exactMatch → trimmedMatch → caseInsensitiveMatch → whitespaceIgnoredMatch
                                                         ↓
                                              (fuzzy match DISABLED)
                                                         ↓
                                                      FAILURE
```

### OpenCode (9 strategies)

```
SimpleReplacer → LineTrimmedReplacer → BlockAnchorReplacer →
WhitespaceNormalizedReplacer → IndentationFlexibleReplacer →
EscapeNormalizedReplacer → TrimmedBoundaryReplacer →
ContextAwareReplacer → MultiOccurrenceReplacer
```

### What OpenCode handles that Continue does not

| Scenario                                                       | OpenCode                                                              | Continue                                                                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| LLM trims each line differently                                | `LineTrimmedReplacer` — per-line `.trim()` comparison                 | No equivalent. `trimmedMatch` only trims the whole search string, not per-line                                             |
| First/last line anchors match but middle lines differ slightly | `BlockAnchorReplacer` with Levenshtein distance                       | No equivalent                                                                                                              |
| LLM normalizes internal whitespace (`\s+` → single space)      | `WhitespaceNormalizedReplacer` with regex-based substring matching    | `whitespaceIgnoredMatch` strips ALL whitespace, which is too aggressive and returns wrong positions for multi-line content |
| LLM uses different indentation level                           | `IndentationFlexibleReplacer` — strips common indent prefix, compares | No equivalent. Indentation adjustment exists but only runs after a match is found                                          |
| LLM escapes/unescapes characters (`\n`, `\"`, `\\`)            | `EscapeNormalizedReplacer`                                            | No equivalent                                                                                                              |
| LLM adds/removes leading/trailing blank lines                  | `TrimmedBoundaryReplacer`                                             | No equivalent                                                                                                              |
| First/last lines match, middle ~50% similar                    | `ContextAwareReplacer`                                                | No equivalent                                                                                                              |

### Impact

When the LLM produces `old_string` with any of these common variations, Continue throws `"string not found in file"` and the LLM must retry (often multiple times), wasting tokens and time.

## Issue 2: `caseInsensitiveMatch` Returns Wrong End Position

```typescript
// findSearchMatch.ts line 75
endIndex: index + searchContent.length,
```

This uses the _original_ `searchContent.length`, but `index` came from matching against the _lowercased_ content. For ASCII this works because `toLowerCase()` preserves length. But the pattern is fragile — if the file uses different-length Unicode case variants (e.g., German `ß` vs `SS`), positions will be wrong.

More practically: when `caseInsensitiveMatch` succeeds, the returned slice `fileContent.slice(startIndex, endIndex)` may not match the actual text at that position if the file content and search content have different lengths after case folding.

## Issue 3: `whitespaceIgnoredMatch` Position Mapping

The position mapping algorithm in `whitespaceIgnoredMatch` (lines 85–142) strips ALL whitespace from both strings, finds the match in stripped space, then maps back to original positions. This works for single-line content but produces incorrect boundaries for multi-line matches where the LLM's whitespace differs structurally from the file's.

Example failure: file has `if (x) {\n    return y;\n}` and LLM provides `if(x){return y;}`. The stripped match succeeds, but the mapped-back `endIndex` includes trailing whitespace from the wrong line.

## Issue 4: Silent JSON Parse Failures in Argument Parsing

```typescript
// parseArgs.ts lines 17-24
try {
  return JSON.parse(toolCall.function?.arguments?.trim() || "{}");
} catch (e) {
  return {}; // Silent failure — returns empty args
}
```

When the LLM produces malformed JSON arguments (common with streaming), the parser silently returns `{}`. Downstream code then fails with confusing errors like `"filepath argument is required"` instead of `"failed to parse tool arguments"`.

OpenCode uses Zod schema validation that produces structured error messages: `"The edit tool was called with invalid arguments: ..."`.

## Issue 5: No Line-Ending Normalization

OpenCode normalizes `\r\n` to `\n` before matching and converts back after:

```typescript
const ending = detectLineEnding(contentOld);
const old = convertToLineEnding(normalizeLineEndings(params.oldString), ending);
const next = convertToLineEnding(
  normalizeLineEndings(params.newString),
  ending,
);
```

Continue performs no line-ending normalization. On Windows files with `\r\n`, if the LLM provides `\n`-only content (common), the exact match fails and falls through to less reliable strategies.

## Issue 6: No Output Truncation

OpenCode truncates tool output to 2000 lines / 50 KB and saves the full output to disk with a hint to use `grep`/`read` for the rest. Continue has no output truncation — a large file read or verbose command output can flood the context window, wasting tokens and potentially hitting context limits.

## Fix Plan

### Fix 1: Add line-trimmed matching strategy

Add a `lineTrimmedMatch` strategy that compares lines after `.trim()` on each line, similar to OpenCode's `LineTrimmedReplacer`. Insert it between `trimmedMatch` and `caseInsensitiveMatch`.

### Fix 2: Add block-anchor matching strategy

Add a `blockAnchorMatch` strategy that matches when the first and last lines of the search content match (after trimming) lines in the file, even if middle lines differ slightly. Uses Levenshtein distance for similarity scoring.

### Fix 3: Add indentation-flexible matching strategy

Add an `indentationFlexibleMatch` strategy that strips common leading indentation from both file blocks and search content before comparing.

### Fix 4: Add line-ending normalization

Normalize `\r\n` to `\n` in both file content and search content before matching. Convert back to the original line ending after replacement.

### Fix 5: Improve argument parse error feedback

When JSON parsing fails in `safeParseToolCallArgs`, include the raw argument string in the error output so the LLM can see what it produced and correct it, rather than silently returning `{}`.

### Fix 6: Add output truncation for tool results

Add a configurable output size limit. When tool output exceeds the limit, truncate and append a message suggesting `read_file_range` or `grep_search`.
