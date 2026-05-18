import type { ChatCommand } from "../adapters/types.ts";
import type { ModelInfo, ProviderModels, RecentMessage, RunnerStatus } from "../pi/runner.ts";
import type { SessionListItem, ThinkingLevel, WorkspaceListItem } from "../pi/runner.ts";

export function formatHelp(commands: ChatCommand[]): string {
  return [
    "Available commands:",
    ...commands.map((item) => `/${item.command} - ${item.description}`),
    "",
    "You can also send a request directly.",
  ].join("\n");
}

export function formatStatus(status: RunnerStatus, busy: boolean, queuedMessages: number): string {
  const model = status.model
    ? formatModelLine(
        status.model.provider,
        status.model.name,
        status.thinkingLevel,
      )
    : "No model selected";
  const context = status.context
    ? `${formatNumber(status.context.tokens)} / ${formatNumber(status.context.contextWindow)}${
        status.context.percent === null
          ? ""
          : ` (${status.context.percent.toFixed(1)}%)`
      }`
    : "unknown";
  const session = status.sessionId.slice(0, 8);
  const cost = status.stats.cost ? `$${status.stats.cost.toFixed(4)}` : "$0";

  return [
    "Status",
    `Model: ${model}`,
    `Context: ${context}`,
    `Workspace: ${status.cwd}`,
    `Session: ${session}`,
    `Busy: ${busy || status.isStreaming ? "yes" : "no"}`,
    `Streaming: ${status.isStreaming ? "yes" : "no"}`,
    `Compacting: ${status.isCompacting ? "yes" : "no"}`,
    `Queue: ${queuedMessages}`,
    `Messages: ${status.stats.totalMessages} (${status.stats.userMessages} user / ${status.stats.assistantMessages} assistant)`,
    `Tools: ${status.activeTools.length}`,
    `Skills: ${status.skillCount}`,
    `Cost: ${cost}`,
  ].join("\n");
}

export function formatProviderMenu(
  groups: ProviderModels[],
  currentModel?: ModelInfo,
  thinkingLevel?: string,
): string {
  if (!groups.length) return "No available models. Check your pi auth/config.";
  const current = currentModel
    ? `Current: ${formatCurrentModel(currentModel, thinkingLevel)}\n\n`
    : "";
  return `${current}Choose a provider:`;
}

export function formatWorkspaceMenu(workspaces: WorkspaceListItem[]): string {
  return [
    "Choose workspace:",
    ...workspaces.map((workspace, index) =>
      `${index + 1}. ${workspace.cwd}${workspace.current ? " (current)" : ""}`,
    ),
  ].join("\n");
}

export function formatThinkingMenu(
  levels: ThinkingLevel[],
  currentLevel: string,
  currentModel?: ModelInfo,
): string {
  if (!levels.length) return "Current model does not support thinking levels.";
  const current = currentModel
    ? formatCurrentModel(currentModel, currentLevel)
    : `thinking ${currentLevel}`;
  return `Current: ${current}\n\nChoose thinking level:`;
}

export function formatResumeMenu(sessions: SessionListItem[]): string {
  if (!sessions.length) return "No previous sessions found.";
  return [
    "Resume a session:",
    ...sessions.map((s, index) => `${index + 1}. ${formatSessionLabel(s)}`),
  ].join("\n");
}

export function formatRecentMessages(messages: RecentMessage[]): string {
  if (!messages.length) return "No recent user, assistant, or summary messages.";
  return messages
    .map((message) => `${recentRoleIcon(message.role)} ${truncate(normalizeRecentText(message.text), 100) ?? ""}`)
    .join("\n");
}

export function formatSessionLabel(session: SessionListItem): string {
  const id = session.id.slice(0, 8);
  const msgs = `${session.messageCount} msg${session.messageCount === 1 ? "" : "s"}`;
  const label = session.name || truncate(session.firstMessage, 40) || "(no messages)";
  const time = formatRelativeTime(session.modified);
  return `${id} • ${msgs} - ${label} • ${time}`;
}

export function formatModelMenu(group: ProviderModels): string {
  return `Choose a model from ${group.provider}:`;
}

export function formatModelLine(
  provider: string,
  modelName: string,
  thinkingLevel: string,
): string {
  return `${provider}/${modelName} • ${thinkingLevel}`;
}

export function formatCurrentModel(model: ModelInfo, thinkingLevel?: string): string {
  return thinkingLevel
    ? formatModelLine(model.provider, model.name, thinkingLevel)
    : `${model.provider}/${model.name}`;
}

function recentRoleIcon(role: RecentMessage["role"]): string {
  if (role === "User") return "👤";
  if (role === "Assistant") return "🧑‍💻";
  return "📝";
}

function normalizeRecentText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncate(value: string | undefined, limit = 100): string | undefined {
  if (!value) return undefined;
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function formatNumber(value: number | null): string {
  return value === null ? "unknown" : Math.round(value).toLocaleString("en-US");
}
