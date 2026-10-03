import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  Harness,
  section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { logger } from "../logger.ts";

/** The host's durable registry, execution environment and persistence policy. */
export async function openWorkspaceHarness(
  directory: string,
  cwd: string,
  models: Models,
): Promise<Harness> {
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(
    defineExtension({
      name: "pilot",
      sections: [
        section(
          "preamble",
          () =>
            "You are Pi Pilot, a coding assistant accessed through Telegram. Use the tools to inspect and modify the workspace, verify your work, and give concise replies. Attached files are supplied as local paths.",
          { tag: false },
        ),
        section("cwd", (input) => input.env?.cwd),
      ],
    }),
  );
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
          new NodeExecutionEnv({ cwd: agentCwd ?? cwd }),
        settings: { toolExecution: "sequential", steeringMode: "all" },
        onReport: (error) => logger.error("durable harness report", error),
      },
      BACKGROUND_CONTEXT,
    );
  } catch (error) {
    await storage.close(BACKGROUND_CONTEXT);
    throw error;
  }
}
