import type { Models } from "@earendil-works/pi-ai";
import type { RuntimeConfig } from "../config/runtime.ts";
import {
  loadWorkspaceModels,
  requireAvailableModel,
  type WorkspaceModelConfig,
} from "./model-config.ts";
import { DurableWorkspace } from "./workspace.ts";
import { compareModels } from "./models.ts";
import { expandSkillPrompt, loadWorkspaceResources } from "./resources.ts";
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
  private readonly injectedModels?: Models;
  private modelConfig?: WorkspaceModelConfig;
  private workspace?: DurableWorkspace;
  private currentCwd: string;
  private outputCallback?: RunnerOutputCallback;
  private readonly operations = new OperationQueue();
  constructor(
    private readonly config: RuntimeConfig,
    options: PiRunnerOptions = {},
  ) {
    this.injectedModels = options.models;
    this.currentCwd = config.workspaces[0] ?? process.cwd();
  }
  private async getWorkspace(): Promise<DurableWorkspace> {
    if (!this.workspace) {
      const loaded = await loadWorkspaceModels(
        this.currentCwd,
        this.injectedModels,
      );
      this.workspace = new DurableWorkspace(
        this.currentCwd,
        loaded.models,
        loaded.defaultModel,
        loaded.harnessSettings,
      );
      this.modelConfig = loaded;
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
    return this.operations.run(async () => {
      const { workspace, ...input } = options;
      if (workspace && workspace !== this.currentCwd)
        throw new Error(
          "Workspace changed while receiving this message. Switch back to its workspace and resend it.",
        );
      return (await this.getWorkspace()).submit(
        await expandSkillPrompt(this.currentCwd, prompt),
        input,
      );
    });
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
    return this.operations.run(async () => {
      const modelsCollection = (await this.getWorkspace()).models;
      const groups = new Map<string, ModelInfo[]>();
      for (const model of [...(await modelsCollection.getAvailable())].sort(
        compareModels,
      )) {
        const group = groups.get(model.provider) ?? [];
        group.push(model);
        groups.set(model.provider, group);
      }
      return [...groups].map(([provider, models]) => ({
        provider,
        displayName: modelsCollection.getProvider(provider)?.name ?? provider,
        models,
      }));
    });
  }
  getWorkspaceDirectory(): string {
    return this.currentCwd;
  }
  async getSkills() {
    return this.operations.run(
      async () => (await loadWorkspaceResources(this.currentCwd)).skills,
    );
  }
  async getProfiles() {
    return this.operations.run(async () => {
      await this.getWorkspace();
      return Object.entries(this.modelConfig!.profiles).map(
        ([name, profile]) => ({ name, ...profile }),
      );
    });
  }
  async setProfile(name: string): Promise<void> {
    await this.operations.run(async () => {
      const workspace = await this.getWorkspace();
      const profile = this.modelConfig!.profiles[name];
      if (!Object.hasOwn(this.modelConfig!.profiles, name) || !profile)
        throw new Error(`Unknown model profile: ${name}`);
      await workspace.setProfile(profile);
    });
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
        await this.replaceWorkspace(cwd);
      }
      return { index, cwd, current: true };
    });
  }
  async reload(): Promise<void> {
    await this.operations.run(async () => {
      await this.replaceWorkspace(this.currentCwd);
    });
  }
  private async replaceWorkspace(cwd: string): Promise<void> {
    await this.workspace?.requireIdle();
    // Build and validate before closing the current store; errors leave it usable.
    const loaded = await loadWorkspaceModels(cwd, this.injectedModels);
    if (cwd === this.currentCwd && this.workspace) {
      const current = await this.workspace.getStatus();
      if (current.model)
        await requireAvailableModel(loaded.models, {
          provider: current.model.provider,
          model: current.model.id,
        });
    }
    const previous = this.workspace;
    const candidate = new DurableWorkspace(
      cwd,
      loaded.models,
      loaded.defaultModel,
      loaded.harnessSettings,
    );
    candidate.setOutputCallback((event) => this.outputCallback?.(event));
    await previous?.dispose();
    try {
      await candidate.init();
    } catch (error) {
      await candidate.dispose();
      await previous?.init();
      throw error;
    }
    this.workspace = candidate;
    this.modelConfig = loaded;
    this.currentCwd = cwd;
  }
  async dispose(): Promise<void> {
    await this.operations.run(async () => {
      await this.workspace?.dispose();
      this.workspace = undefined;
    });
  }
}
