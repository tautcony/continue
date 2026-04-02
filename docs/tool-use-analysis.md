# Continue Agent Tool Use 问题分析与修正方案

## 概述

本文档分析 Continue CLI Agent 的 tool use 实现存在的问题，参照 OpenCode 的设计，找出导致文件操作频繁失败、任务执行效率低下的根本原因，并提出修正方案。

---

## OpenCode vs Continue 工具调用对比

### OpenCode 的工具设计（参考）

OpenCode 工具调用设计遵循以下原则：
- **简单直接**：Read、Write 工具相互独立，Write 不依赖先前的 Read
- **原子操作**：每次工具调用都是独立的文件系统操作
- **清晰的错误信息**：文件不存在时直接返回 `FileNotFound`，帮助 LLM 理解应该先创建文件

### Continue 的工具设计

Continue CLI 的文件操作工具：

| 工具 | 功能 | 约束 |
|------|------|------|
| `Read` | 读取文件内容 | 标记文件为"已读" |
| `Write` | 全量写入文件 | 无前置条件 |
| `Edit` | 基于 old_string/new_string 修改文件 | **必须先调用 Read** |
| `MultiEdit` | 对同一文件执行多次 Edit | **必须先调用 Read** |

Continue 的 `Edit`/`MultiEdit` 工具引入了一个"已读文件集合"（`readFilesSet`）机制，**强制要求 LLM 在编辑前先读取文件**。这导致了几个严重问题。

---

## 发现的问题

### Bug 1：`validateAndResolveFilePath` 中死代码导致错误信息不可读

**文件**：`extensions/cli/src/tools/edit.ts`

**问题描述**：

```typescript
export function validateAndResolveFilePath(args: any) {
  // ...
  const absolutePath = path.isAbsolute(file_path)
    ? file_path
    : path.resolve(process.cwd(), file_path);

  // ❌ 问题：当文件不存在时，realpathSync 直接抛出 ENOENT 异常
  const resolvedPath = fs.realpathSync(absolutePath);

  throwIfFileIsSecurityConcern(resolvedPath);

  // ❌ 死代码：永远不会执行到这里（realpathSync 已经先抛了 ENOENT）
  if (!fs.existsSync(resolvedPath)) {
    throw new ContinueError(
      ContinueErrorReason.FileNotFound,
      `File ${file_path} does not exist`,
    );
  }
  // ...
}
```

**影响**：

当 LLM 试图编辑一个不存在的文件时，会收到如下错误：
```
ENOENT: no such file or directory, lstat '/path/to/file'
```

而不是期望的清晰错误信息：
```
File /path/to/file does not exist
```

`ENOENT` 错误没有被捕获为 `ContinueError`，导致：
1. LLM 无法从错误类型（`FileNotFound`）判断应该先创建文件
2. LLM 更难从错误信息理解问题原因，需要额外轮次才能恢复
3. 增加任务失败率

**复现测试**：见 `extensions/cli/src/tools/edit.test.ts` 中的 `should return FileNotFound error when file does not exist` 用例。

---

### Bug 2：同批次并行 Read+Edit 必然失败

**文件**：`extensions/cli/src/tools/readFile.ts`、`extensions/cli/src/tools/edit.ts`、`extensions/cli/src/stream/streamChatResponse.helpers.ts`

**问题描述**：

现代 LLM（如 Claude 3.5/4、GPT-4o）支持并行工具调用（parallel tool calls）。当 LLM 在同一批次中同时发出 `Read` 和 `Edit` 调用时，必然失败：

**调用流程**：
```
preprocessStreamedToolCalls():
  → Read.preprocess()   // 只做安全检查，不标记文件为已读
  → Edit.preprocess()   // 检查 readFilesSet → 文件未标记 → 抛出 EditToolFileNotRead!

executeStreamedToolCalls():
  → Read.run()          // 真正读取文件，这里才调用 markFileAsRead()
  → Edit.run()          // 永远不会执行
```

**根本原因**：`markFileAsRead()` 在 `readFileTool.run()` 中调用，但 `readFilesSet` 的检查在 `editTool.preprocess()` 中进行。由于所有 `preprocess` 先于所有 `run` 执行，在同批次中 Read 的 `run` 还没有执行时，Edit 的 `preprocess` 就已经失败了。

**影响**：

1. LLM 并行调用 Read+Edit → Edit 失败
2. LLM 收到 `EditToolFileNotRead` 错误，重新尝试 → 单独调用 Read → 再调用 Edit
3. 每次编辑至少需要 **2 次以上的 LLM 调用**（Read 一次，Edit 一次），而不是理想的 1 次并行
4. 某些模型可能陷入循环，反复收到同样的错误而无法理解原因

**复现测试**：见 `extensions/cli/src/tools/edit.test.ts` 中的 `should succeed when Read and Edit are issued in the same parallel batch` 用例。

---

### 设计问题：Edit 强制依赖 Read 增加额外轮次

**设计意图**：强制 LLM 在编辑前读取文件，保证 LLM 有文件的最新内容和上下文。

**实际效果**：

即使没有并行调用，每次 Edit 操作都需要：
1. 第 N 轮：LLM 调用 `Read(file.ts)` → 获取文件内容
2. 第 N+1 轮：LLM 调用 `Edit(file.ts, old, new)` → 修改文件

相比之下，OpenCode 的 Write 工具直接覆盖文件，不需要预读。

**注意**：这个设计问题是有意为之的（防止 LLM 在没有上下文的情况下盲目修改文件），但在多文件批量修改场景中会大幅增加 LLM 调用次数。

---

### 其他注意事项

**`readFileTool.preprocess` 返回原始 args**：

```typescript
preprocess: async (args) => {
  let { filepath } = args;
  if (filepath.startsWith("./")) {
    filepath = filepath.slice(2);  // 只修改本地变量
  }
  throwIfFileIsSecurityConcern(filepath);  // 用修改后的路径做安全检查
  return {
    args,  // ⚠️ 返回的是原始 args，filepath 仍有 './' 前缀
    preview: [...],
  };
},
```

`run` 函数也会做同样的 `./` 处理，因此实际运行是正确的，但代码逻辑容易引起混淆。

---

## 修正方案

### 修复 Bug 1：在 `realpathSync` 之前检查文件存在性

**文件**：`extensions/cli/src/tools/edit.ts`

**修改**：在 `validateAndResolveFilePath` 函数中，将 `existsSync` 检查移到 `realpathSync` 之前：

```typescript
export function validateAndResolveFilePath(args: any) {
  const { file_path } = args;

  if (!file_path) {
    throw new ContinueError(
      ContinueErrorReason.FindAndReplaceMissingFilepath,
      "file_path is required",
    );
  }

  const absolutePath = path.isAbsolute(file_path)
    ? file_path
    : path.resolve(process.cwd(), file_path);

  // ✅ 先检查文件是否存在，避免 realpathSync 抛出 ENOENT
  if (!fs.existsSync(absolutePath)) {
    throw new ContinueError(
      ContinueErrorReason.FileNotFound,
      `File ${file_path} does not exist`,
    );
  }

  const resolvedPath = fs.realpathSync(absolutePath);
  throwIfFileIsSecurityConcern(resolvedPath);

  if (!readFilesSet.has(resolvedPath)) {
    throw new ContinueError(
      ContinueErrorReason.EditToolFileNotRead,
      `You must use the ${readFileTool.name} tool to read ${file_path} before editing it.`,
    );
  }

  return { originalPath: file_path, resolvedPath };
}
```

### 修复 Bug 2：在 `readFileTool.preprocess` 中提前标记文件为已读

**文件**：`extensions/cli/src/tools/readFile.ts`

**修改**：在 `readFileTool.preprocess` 中，对存在的文件提前调用 `markFileAsRead`，使 `Edit` 在同批次中能够识别文件已被标记：

```typescript
preprocess: async (args) => {
  let { filepath } = args;
  if (filepath.startsWith("./")) {
    filepath = filepath.slice(2);
  }
  throwIfFileIsSecurityConcern(filepath);

  // ✅ 提前标记文件为已读，使同批次的 Edit 调用能够成功
  try {
    const absolutePath = path.isAbsolute(filepath)
      ? filepath
      : path.resolve(process.cwd(), filepath);
    if (fs.existsSync(absolutePath)) {
      const realPath = fs.realpathSync(absolutePath);
      markFileAsRead(realPath);
    }
  } catch {
    // 忽略错误 - run() 阶段会给出明确的错误信息
  }

  return {
    args,
    preview: [
      {
        type: "text",
        content: `Will read ${formatToolArgument(filepath)}`,
      },
    ],
  };
},
```

---

## 修复效果

### Bug 1 修复后

编辑不存在的文件：
- **修复前**：`ENOENT: no such file or directory, lstat '/path/to/file'`  
- **修复后**：`File /path/to/file does not exist`（`ContinueError` with `FileNotFound` reason）

### Bug 2 修复后

LLM 在同一批次并行调用 Read+Edit：
- **修复前**：Edit 失败，需要 2+ 次额外轮次
- **修复后**：Edit 成功，Read 和 Edit 在同批次执行完成

---

## 相关文件

| 文件 | 作用 |
|------|------|
| `extensions/cli/src/tools/readFile.ts` | Read 工具，管理 `readFilesSet` |
| `extensions/cli/src/tools/edit.ts` | Edit 工具，包含 `validateAndResolveFilePath` |
| `extensions/cli/src/tools/multiEdit.ts` | MultiEdit 工具（复用 `validateAndResolveFilePath`） |
| `extensions/cli/src/tools/writeFile.ts` | Write 工具（无前置条件，不受此问题影响） |
| `extensions/cli/src/stream/streamChatResponse.helpers.ts` | 工具调用预处理和执行流程 |
| `extensions/cli/src/tools/edit.test.ts` | Edit 工具单元测试（含本次新增的 Bug 复现测试）|
| `extensions/cli/src/tools/multiEdit.test.ts` | MultiEdit 工具单元测试 |
