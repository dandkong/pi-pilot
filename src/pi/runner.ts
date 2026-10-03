import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { RuntimeConfig } from "../config/runtime.ts";
import { DurableWorkspace } from "./workspace.ts";
import { compareModels } from "./models.ts";
import type {
  AdmittedInput,
  ModelInfo,
  PiRunnerOptions,
  ProviderModels,
  RecentMessage,
  RunnerOutputCallback,
  RunnerStatus,
  RuntimeStatus,
  SessionListItem,
  SubmitOptions,
  ThinkingLevel,
  WorkspaceListItem,
} from "./types.ts";
export type * from "./types.ts";
class OperationQueue {
  private pending = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
export class PiRunner {
  private readonly models: Models;
  private readonly dataDir: string;
  private workspace?: DurableWorkspace;
  private currentCwd: string;
  private outputCallback?: RunnerOutputCallback;
  private readonly operations = new OperationQueue();
  constructor(
    private readonly config: RuntimeConfig,
    options: PiRunnerOptions = {},
  ) {
    this.models = options.models ?? builtinModels();
    this.dataDir = resolve(
      options.dataDir ??
        config.dataDir ??
        join(homedir(), ".pi", "pilot", "durable"),
    );
    this.currentCwd = config.workspaces[0] ?? process.cwd();
  }
  private async getWorkspace(): Promise<DurableWorkspace> {
    if (!this.workspace) {
      this.workspace = new DurableWorkspace(
        this.currentCwd,
        this.models,
        this.dataDir,
        this.config.model,
      );
      if (this.outputCallback)
        this.workspace.setOutputCallback(this.outputCallback);
    }
    await this.workspace.init();
    return this.workspace;
  }
  async init(): Promise<void> {
    await this.operations.run(async () => {
      await this.getWorkspace();
    });
  }
  setOutputCallback(callback: RunnerOutputCallback): void {
    this.outputCallback = callback;
    this.workspace?.setOutputCallback(callback);
  }
  async submit(
    prompt: string,
    options: SubmitOptions = {},
  ): Promise<AdmittedInput> {
    return this.operations.run(async () =>
      (await this.getWorkspace()).submit(prompt, options),
    );
  }
  async run(prompt: string, options: SubmitOptions = {}): Promise<void> {
    const input = await this.submit(prompt, options);
    await input.wait();
  }
  async getStatus(): Promise<RunnerStatus> {
    return this.operations.run(async () =>
      (await this.getWorkspace()).getStatus(),
    );
  }
  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return this.operations.run(async () =>
      (await this.getWorkspace()).getRuntimeStatus(),
    );
  }
  async getRecentMessages(limit = 6): Promise<RecentMessage[]> {
    return this.operations.run(async () =>
      (await this.getWorkspace()).getRecentMessages(limit),
    );
  }
  async getProviderModels(): Promise<ProviderModels[]> {
    const groups = new Map<string, ModelInfo[]>();
    for (const model of [...(await this.models.getAvailable())].sort(
      compareModels,
    )) {
      const group = groups.get(model.provider) ?? [];
      group.push(model);
      groups.set(model.provider, group);
    }
    return [...groups].map(([provider, models]) => ({
      provider,
      displayName: this.models.getProvider(provider)?.name ?? provider,
      models,
    }));
  }
  async setModel(provider: string, index: number): Promise<ModelInfo> {
    return this.operations.run(async () =>
      (await this.getWorkspace()).setModel(provider, index),
    );
  }
  async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
    return this.operations.run(async () =>
      (await this.getWorkspace()).getAvailableThinkingLevels(),
    );
  }
  async setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    return this.operations.run(async () =>
      (await this.getWorkspace()).setThinkingLevel(level),
    );
  }
  async abort(): Promise<void> {
    const stopped = await this.operations.run(async () =>
      (await this.getWorkspace()).abort(),
    );
    await stopped.wait();
  }
  async compact(): Promise<void> {
    const task = await this.operations.run(async () =>
      (await this.getWorkspace()).startCompaction(),
    );
    await task.wait();
  }
  async listSessions(): Promise<SessionListItem[]> {
    return this.operations.run(async () =>
      (await this.getWorkspace()).listSessions(),
    );
  }
  async switchSession(index: number): Promise<SessionListItem> {
    return this.operations.run(async () =>
      (await this.getWorkspace()).switchSession(index),
    );
  }
  async newSession(): Promise<string> {
    return this.operations.run(async () =>
      (await this.getWorkspace()).newSession(),
    );
  }
  listWorkspaces(): WorkspaceListItem[] {
    return this.config.workspaces.map((cwd, index) => ({
      index,
      cwd,
      current: cwd === this.currentCwd,
    }));
  }
  async switchWorkspace(index: number): Promise<WorkspaceListItem> {
    return this.operations.run(async () => {
      const cwd = this.config.workspaces[index];
      if (!cwd) throw new Error(`Invalid workspace index: ${index}`);
      if (cwd !== this.currentCwd) {
        await this.workspace?.requireIdle();
        await this.workspace?.dispose();
        this.workspace = undefined;
        this.currentCwd = cwd;
        await this.getWorkspace();
      }
      return { index, cwd, current: true };
    });
  }
  async reload(): Promise<void> {
    await this.operations.run(async () => {
      await this.workspace?.requireIdle();
      await this.workspace?.dispose();
      this.workspace = undefined;
      await this.getWorkspace();
    });
  }
  async dispose(): Promise<void> {
    await this.operations.run(async () => {
      await this.workspace?.dispose();
      this.workspace = undefined;
    });
  }
}
