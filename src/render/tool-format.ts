import type { ToolEvent } from "../pi/types.ts";

const TOOL_ARG_LIMIT = 3;
const TOOL_SUMMARY_LIMIT = 140;
const TOOL_VALUE_LIMIT = 60;

export function formatToolStart(event: ToolEvent): string {
  const name = String(event.toolName ?? "tool");
  const icon = toolIcon(name);
  const summary = summarizeToolArgs(name, event.args);
  return summary ? `${icon} ${name}: ${summary}` : `${icon} ${name}`;
}

function toolIcon(toolName: string): string {
  if (toolName === "read") return "📖";
  if (toolName === "bash") return "💻";
  if (toolName === "edit") return "📝";
  if (toolName === "write") return "📄";
  return "🛠️";
}

function summarizeToolArgs(
  toolName: string,
  args: unknown,
): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;

  if (toolName === "read") return truncate(pickString(record, "path"));
  if (toolName === "bash") return truncate(pickString(record, "command"));
  if (toolName === "write") return truncate(pickString(record, "path"));
  if (toolName === "edit") {
    const path = pickString(record, "path");
    if (!path) return undefined;
    const editCount = Array.isArray(record.edits)
      ? record.edits.length
      : undefined;
    const suffix =
      editCount === undefined
        ? ""
        : ` (${editCount} edit${editCount === 1 ? "" : "s"})`;
    return truncate(`${path}${suffix}`);
  }

  return summarizeGenericArgs(record);
}

function summarizeGenericArgs(
  record: Record<string, unknown>,
): string | undefined {
  const entries = Object.entries(record);
  if (entries.length === 0) return undefined;

  const parts = entries
    .slice(0, TOOL_ARG_LIMIT)
    .map(([key, value]) => `${key}=${formatGenericValue(value)}`);
  if (entries.length > TOOL_ARG_LIMIT)
    parts.push(`+${entries.length - TOOL_ARG_LIMIT} more`);

  return truncate(parts.join(", "), TOOL_SUMMARY_LIMIT);
}

function formatGenericValue(value: unknown): string {
  if (typeof value === "string")
    return JSON.stringify(truncate(value, TOOL_VALUE_LIMIT) ?? "");
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const preview = value
      .slice(0, 3)
      .map((item) => formatGenericValue(item))
      .join(", ");
    return `[${preview}${value.length > 3 ? ", ..." : ""}]`;
  }
  if (typeof value === "object" && value) {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length
      ? `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", ..." : ""}}`
      : "{}";
  }
  return String(value);
}

function pickString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncate(
  value: string | undefined,
  limit = TOOL_SUMMARY_LIMIT,
): string | undefined {
  if (!value) return undefined;
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}
