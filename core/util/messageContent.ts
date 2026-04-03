import {
  ChatMessage,
  ContextItem,
  MessageContent,
  MessagePart,
  TextMessagePart,
} from "../index";

export function stripImages(messageContent: MessageContent): string {
  if (typeof messageContent === "string") {
    return messageContent;
  }

  return messageContent
    .filter((part) => part.type === "text")
    .map((part) => (part as TextMessagePart).text)
    .join("\n");
}

export function renderChatMessage(message: ChatMessage): string {
  switch (message?.role) {
    case "user":
    case "assistant":
    case "thinking":
    case "system":
      return stripImages(message.content);
    case "tool":
      return message.content;
    default:
      return "";
  }
}

const MAX_TOOL_OUTPUT_LINES = 2000;
const MAX_TOOL_OUTPUT_BYTES = 50 * 1024; // 50 KB

/**
 * Truncate tool output if it exceeds size limits.
 * Appends a hint to use read_file_range or grep_search for the full output.
 */
export function truncateToolOutput(text: string): string {
  const lines = text.split("\n");
  const byteLength = (s: string) =>
    typeof Buffer !== "undefined"
      ? Buffer.byteLength(s, "utf-8")
      : new TextEncoder().encode(s).length;
  const totalBytes = byteLength(text);

  if (
    lines.length <= MAX_TOOL_OUTPUT_LINES &&
    totalBytes <= MAX_TOOL_OUTPUT_BYTES
  ) {
    return text;
  }

  const out: string[] = [];
  let bytes = 0;

  for (let i = 0; i < lines.length && i < MAX_TOOL_OUTPUT_LINES; i++) {
    const lineBytes = byteLength(lines[i]) + 1;
    if (bytes + lineBytes > MAX_TOOL_OUTPUT_BYTES) {
      break;
    }
    out.push(lines[i]);
    bytes += lineBytes;
  }

  const totalLines = lines.length;
  const shownLines = out.length;

  return (
    out.join("\n") +
    `\n\n... (truncated ${totalLines - shownLines} of ${totalLines} lines). ` +
    `Use read_file_range with startLine/endLine to read specific sections, ` +
    `or grep_search to find specific content.`
  );
}

export function renderContextItems(contextItems: ContextItem[]): string {
  const raw = contextItems.map((item) => item.content).join("\n\n");
  return truncateToolOutput(raw);
}

export function renderContextItemsWithStatus(contextItems: any[]): string {
  return contextItems
    .map((item) => {
      let result = item.content;

      // If this item has a status, append it directly after the content
      if (item.status) {
        result += `\n[Status: ${item.status}]`;
      }

      return result;
    })
    .join("\n\n");
}

export function normalizeToMessageParts(message: ChatMessage): MessagePart[] {
  switch (message.role) {
    case "user":
    case "assistant":
    case "thinking":
    case "system":
      return Array.isArray(message.content)
        ? message.content
        : [{ type: "text", text: message.content }];
    case "tool":
      return [{ type: "text", text: message.content }];
  }
}
