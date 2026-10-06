import type {
  Api,
  Model,
  Models,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { RunnerEvent } from "./events.ts";

export type ModelInfo = Model<Api>;
export type ProviderModels = {
  provider: string;
  displayName: string;
  models: ModelInfo[];
};
export type ToolEvent = {
  toolName?: unknown;
  toolCallId?: unknown;
  args?: unknown;
};
export type ThinkingLevel = ModelThinkingLevel;
export type RunnerOutputCallback = (event: RunnerEvent) => void | Promise<void>;
export type SessionListItem = {
  id: string;
  name?: string;
  path: string;
  messageCount: number;
  firstMessage: string;
  modified: Date;
};
export type WorkspaceListItem = {
  index: number;
  cwd: string;
  current: boolean;
};
export type RuntimeStatus = {
  isRunning: boolean;
  isCompacting: boolean;
  pendingMessages: number;
};
export type RunnerStatus = RuntimeStatus & {
  cwd: string;
  sessionId: string;
  model?: ModelInfo;
  thinkingLevel: string;
  context?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  stats: {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalMessages: number;
    cost: number;
  };
  activeTools: string[];
  extensionCount: number;
};
export type RecentMessage = {
  role: "User" | "Assistant" | "Summary";
  text: string;
};
export type PiRunnerOptions = { models?: Models };

export type SubmitOptions = {
  workspace?: string;
  whenBusy?: "steer" | "followUp" | "reject";
  requestId?: string;
};
export type OperationCompletion = { wait(): Promise<void> };
export type AdmittedInput = OperationCompletion & {
  id: number;
  queued: boolean;
};
