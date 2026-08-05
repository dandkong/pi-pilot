import type { InlineButton } from "../adapters/types.ts";
import type { ProviderModels } from "../pi/runner.ts";
import type { SessionListItem, ThinkingLevel, WorkspaceListItem } from "../pi/runner.ts";

export const MODELS_HOME = "models:home";
export const RESUME_PREFIX = "resume";
export const THINKING_PREFIX = "thinking";
export const WORKSPACE_PREFIX = "workspace";
export const DELETE_PREFIX = "delete";

export function resumeButtons(sessions: SessionListItem[]): InlineButton[][] {
  return [sessions.map((_, index) => ({
    text: String(index + 1),
    callbackData: `${RESUME_PREFIX}:${index}`,
  }))];
}

export function deleteButtons(sessions: SessionListItem[]): InlineButton[][] {
  return chunkButtons(
    sessions.map((session, index) => ({
      text: String(index + 1),
      callbackData: `${DELETE_PREFIX}:${session.id}`,
    })),
    5,
  );
}

export function workspaceButtons(workspaces: WorkspaceListItem[]): InlineButton[][] {
  return chunkButtons(
    workspaces.map((_, index) => ({
      text: String(index + 1),
      callbackData: `${WORKSPACE_PREFIX}:${index}`,
    })),
    5,
  );
}

export function thinkingButtons(levels: ThinkingLevel[], currentLevel: string): InlineButton[][] {
  return chunkButtons(
    levels.map((level) => ({
      text: level === currentLevel ? `${level} ✓` : level,
      callbackData: `${THINKING_PREFIX}:${level}`,
    })),
    3,
  );
}

export function providerButtons(groups: ProviderModels[]): InlineButton[][] {
  return chunkButtons(
    groups.map((group) => ({
      text: `${group.provider} (${group.models.length})`,
      callbackData: `models:provider:${encodeURIComponent(group.provider)}`,
    })),
    2,
  );
}

export function modelButtons(group: ProviderModels): InlineButton[][] {
  const rows = chunkButtons(
    group.models.map((model, index) => ({
      text: model.name,
      callbackData: `models:set:${encodeURIComponent(group.provider)}:${index}`,
    })),
    2,
  );
  rows.push([{ text: "Back to providers", callbackData: MODELS_HOME }]);
  return rows;
}

export function chunkButtons(
  buttons: InlineButton[],
  columns: number,
): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += columns) {
    rows.push(buttons.slice(i, i + columns));
  }
  return rows;
}
