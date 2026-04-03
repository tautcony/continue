# Tool Use: Continue vs OpenCode — Source-Level Comparison

Comparative analysis based on a full read of [OpenCode dev branch](https://github.com/anomalyco/opencode/tree/dev) source code vs Continue's current implementation. Identifies remaining gaps after the initial fixes.

## Architecture Differences

### OpenCode's Design (Generator-based Replacers)

OpenCode's `replace()` function (in `packages/opencode/src/tool/edit.ts`) uses **generator-based replacers**. Each replacer is a `function*` that yields candidate search strings. The `replace()` function iterates these candidates and performs the actual `content.indexOf(search)` on each one:

```typescript
// OpenCode: each replacer yields the actual text to search for in the file
export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  for (const replacer of [...allReplacers]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)        // always exact match on the yielded text
      if (index === -1) continue
      if (replaceAll) return content.replaceAll(search, newString)
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue              // skip if multiple occurrences
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }
  // ...error handling
}
```

The key insight: **OpenCode replacers yield the actual file content** that matches the search. This means the replacement is always a simple `content.indexOf(yieldedText)` — no position mapping, no index tracking. The complexity is in the *finding* step, not the *replacing* step.

### Continue's Design (Position-based Strategies)

Continue uses position-based strategies that return `{startIndex, endIndex}` pairs. This requires complex position mapping for non-exact strategies (especially `whitespaceIgnoredMatch`), which is where bugs occur.

```typescript
// Continue: each strategy returns character positions in the file
type MatchStrategy = (fileContent: string, searchContent: string) => BasicMatchResult | null
// Then replacement slices at those positions: file.slice(0, start) + newString + file.slice(end)
```

### Practical Consequence

OpenCode's approach is inherently safer because:
1. No position mapping needed — the yielded string is always the literal text from the file
2. Multiple candidates can be evaluated — a replacer can yield several options
3. The `content.indexOf(search)` at the end guarantees the replacement targets the right text

Continue's approach requires each strategy to correctly calculate start/end positions, which is error-prone for fuzzy strategies.

## Strategy-by-Strategy Comparison

### Strategies Continue Already Has (after previous PR)

| # | OpenCode Replacer | Continue Equivalent | Notes |
|---|---|---|---|
| 1 | `SimpleReplacer` | `exactMatch` | Identical — exact `indexOf` |
| 2 | `LineTrimmedReplacer` | `lineTrimmedMatch` | Same algorithm — per-line `.trim()` comparison |
| 3 | `BlockAnchorReplacer` | `blockAnchorMatch` | Same algorithm — Levenshtein scoring with same thresholds (0.0/0.3) |
| 5 | `IndentationFlexibleReplacer` | `indentationFlexibleMatch` | Same algorithm — `removeCommonIndent` |

### Strategies Continue is Still Missing

| # | OpenCode Replacer | What it does | Continue gap |
|---|---|---|---|
| 4 | `WhitespaceNormalizedReplacer` | Normalizes `\s+` to single space, then matches line-by-line or substring. Also handles multi-line blocks. Uses regex to find the actual matching substring in the original content. | Continue has `whitespaceIgnoredMatch` which strips ALL whitespace — too aggressive. Doesn't preserve word boundaries and can produce wrong positions. |
| 6 | `EscapeNormalizedReplacer` | Unescapes `\n`, `\t`, `\r`, `\'`, `\"`, `` \` ``, `\\`, `\$` in the search string, then tries finding the unescaped version in the file. Also tries unescaping both sides. | **Completely missing**. LLMs sometimes produce escaped strings like `\\n` instead of literal newlines. |
| 7 | `TrimmedBoundaryReplacer` | Trims whitespace from the search string, then tries `content.includes(trimmed)`. Also tries finding blocks where `block.trim() === trimmedFind`. | Continue's `trimmedMatch` only does `content.indexOf(searchContent.trim())` — it doesn't try block-level trim matching. |
| 8 | `ContextAwareReplacer` | Like `BlockAnchorReplacer` but requires exact line count match and checks if ≥50% of middle lines match exactly (not Levenshtein). | `blockAnchorMatch` partially covers this but with different logic. |
| 9 | `MultiOccurrenceReplacer` | Yields ALL exact matches by iterating `indexOf` with advancing `startIndex`. Used when `replaceAll=true`. | Continue's `findSearchMatches` does this for exact match only. Non-exact strategies don't support this. |

### OpenCode `WhitespaceNormalizedReplacer` (line 375-417) — Detailed

```typescript
// OpenCode approach: normalize whitespace to single space, then try 3 matching modes:
// 1. Full line match: normalizeWhitespace(line) === normalizedFind
// 2. Substring match: normalizeWhitespace(line).includes(normalizedFind)
//    → uses regex to extract the actual matching text
// 3. Multi-line block match: normalizeWhitespace(block.join("\n")) === normalizedFind
```

Continue's `whitespaceIgnoredMatch` strips ALL whitespace (including newlines) and maps positions back, which is fundamentally different and more error-prone.

### OpenCode `EscapeNormalizedReplacer` (line 447-494) — Detailed

Handles these escape sequences:
- `\\n` → `\n`, `\\t` → `\t`, `\\r` → `\r`
- `\\'` → `'`, `\\"` → `"`, `` \\` `` → `` ` ``
- `\\\\` → `\\`, `\\$` → `$`

This is surprisingly common — LLMs often produce double-escaped strings when the file content contains string literals with escape sequences.

## Other Critical Differences

### 1. Invalid Tool Handler

OpenCode has a dedicated `InvalidTool` (in `tool/invalid.ts`) that catches tool calls with malformed arguments:

```typescript
// In llm.ts line 265-284:
async experimental_repairToolCall(failed) {
  // Fix tool name casing issues
  const lower = failed.toolCall.toolName.toLowerCase()
  if (lower !== failed.toolCall.toolName && tools[lower]) {
    return { ...failed.toolCall, toolName: lower }
  }
  // Route to InvalidTool with error details
  return {
    ...failed.toolCall,
    input: JSON.stringify({ tool: failed.toolCall.toolName, error: failed.error.message }),
    toolName: "invalid",
  }
}
```

Continue has no equivalent. When a tool call fails argument validation, the error goes through `callTool`'s try-catch and returns an error string. OpenCode's approach is more robust:
1. It fixes case-sensitivity issues (e.g., `Read` → `read`)
2. It routes to a dedicated error tool that explains *what* went wrong

### 2. Doom Loop Detection

OpenCode detects when the LLM calls the same tool with the same arguments 3 times in a row (see `processor.ts` line 188-201):

```typescript
const DOOM_LOOP_THRESHOLD = 3
// ...
const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)
if (recentParts.every(part =>
  part.type === "tool" && part.tool === value.toolName &&
  JSON.stringify(part.state.input) === JSON.stringify(value.input)
)) {
  // Ask permission to continue or stop
}
```

Continue has no equivalent doom-loop detection.

### 3. File Modification Time Tracking

OpenCode tracks file modification times and asserts before edits (see `FileTime.assert` in `edit.ts` line 88). This prevents edits to files that were modified externally since the LLM last read them, which could cause data loss.

Continue has no equivalent staleness detection.

### 4. LSP Integration Post-Edit

After editing a file, OpenCode checks LSP diagnostics and reports errors back to the LLM:

```typescript
// edit.ts line 145-155
await LSP.touchFile(filePath, true)
const diagnostics = await LSP.diagnostics()
const errors = issues.filter(item => item.severity === 1)
if (errors.length > 0) {
  output += `\nLSP errors detected, please fix:\n<diagnostics>...</diagnostics>`
}
```

This gives the LLM immediate feedback on whether its edit introduced compilation errors, significantly reducing retry loops.

### 5. Truncation Architecture

OpenCode's truncation (in `tool/truncate.ts`) saves full output to a temp file and provides a path:

```typescript
// truncate.ts: saves full output to disk, returns truncated preview + file path
return {
  content: `${preview}\n\n...${removed} ${unit} truncated...\n\nFull output saved to: ${file}`,
  truncated: true,
  outputPath: file,
}
```

Continue's truncation (in `messageContent.ts`) only truncates inline — the full output is lost.

### 6. Read Tool Design

OpenCode's `ReadTool` has several features Continue's equivalent lacks:
- **Line-level offset/limit**: `offset` and `limit` parameters for paginated reading
- **Line number prefixing**: Each line includes its number (`42: content`) for reference
- **Max line length**: Truncates individual lines >2000 chars with a suffix
- **Max bytes cap**: 50 KB per read, with continuation hint
- **Binary file detection**: Checks for null bytes and non-printable character ratio
- **Image/PDF support**: Reads images and PDFs as base64 attachments
- **File-not-found suggestions**: Suggests similar filenames when a path is wrong

### 7. Retry with Backoff

OpenCode has sophisticated retry logic (in `session/retry.ts`) with:
- Exponential backoff: `2000 * 2^(attempt-1)`
- `Retry-After` header parsing (both seconds and milliseconds)
- HTTP date format parsing
- Rate limit detection from response bodies
- Context overflow detection (never retried)

### 8. Zod Schema Validation

OpenCode validates tool arguments with Zod schemas in the tool framework (see `tool.ts` lines 61-71):

```typescript
try {
  toolInfo.parameters.parse(args)
} catch (error) {
  if (error instanceof z.ZodError && toolInfo.formatValidationError) {
    throw new Error(toolInfo.formatValidationError(error), { cause: error })
  }
  throw new Error(
    `The ${id} tool was called with invalid arguments: ${error}.\nPlease rewrite the input.`,
    { cause: error },
  )
}
```

This provides structured validation error messages. Continue uses manual argument extraction with `getStringArg`/`getNumberArg` which throws less informative errors.

## Remaining Fixes Needed

### Priority 1: Add `EscapeNormalizedReplacer` equivalent

LLMs frequently produce escape-sequence errors. Add an `escapeNormalizedMatch` strategy that unescapes common sequences before matching.

### Priority 2: Replace `whitespaceIgnoredMatch` with `WhitespaceNormalizedReplacer` equivalent

The current `whitespaceIgnoredMatch` is too aggressive (strips ALL whitespace). Replace it with a `whitespaceNormalizedMatch` that normalizes `\s+` to single space, similar to OpenCode's approach.

### Priority 3: Add `ContextAwareReplacer` equivalent

A complementary fuzzy matcher to `blockAnchorMatch` that uses a simpler exact-line-match heuristic (≥50% match threshold) instead of Levenshtein distance.

### Priority 4: Full output preservation on truncation

Save full output to a temp file when truncated, include the path in the truncation message.

### Lower Priority (Architecture Differences)

These are fundamental architecture differences requiring more significant changes:
- Doom loop detection
- File modification time tracking
- LSP diagnostic feedback after edits
- `experimental_repairToolCall` for malformed tool calls
- Read tool enhancements (offset/limit, line numbers, binary detection)
