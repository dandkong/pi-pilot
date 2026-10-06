import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  Harness,
  type HarnessSettings,
  type Registry,
  section,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { logger } from "../logger.ts";
import { workspacePaths } from "../config/paths.ts";
import { WorkspaceExecutionEnv } from "./execution-env.ts";
import { createWorkspaceResourcesExtension } from "./resources.ts";
import { installWorkspacePlugins } from "./extensions.ts";

/** Compose and validate a fresh registry before replacing an active workspace. */
export async function loadWorkspaceRegistry(cwd: string) {
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(
    defineExtension({
      name: "pilot",
      sections: [section("cwd", (input) => input.env?.cwd)],
    }),
  );
  registry.install(createWorkspaceResourcesExtension(cwd));
  return installWorkspacePlugins(cwd, registry);
}

export async function openWorkspaceHarness(
  directory: string,
  cwd: string,
  models: Models,
  settings: HarnessSettings,
  registry: Registry,
): Promise<Harness> {
  const storage = await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT, {
    fsync: true,
  });
  try {
    return await Harness.open(
      storage,
      {
        models,
        registry,
        env: ({ cwd: agentCwd }) =>
          new WorkspaceExecutionEnv(agentCwd ?? cwd, workspacePaths(cwd).tmp),
        settings: {
          ...settings,
          toolExecution: "sequential",
          steeringMode: "all",
        },
        onReport: (error) => logger.error("durable harness report", error),
      },
      BACKGROUND_CONTEXT,
    );
  } catch (error) {
    await storage.close(BACKGROUND_CONTEXT);
    throw error;
  }
}
