import { join } from "node:path";
import { Type, type Static } from "typebox";
import { readJson } from "./files.ts";
import { workspacePaths } from "./paths.ts";

export const object = <T extends Record<string, import("typebox").TSchema>>(
  fields: T,
) => Type.Object(fields, { additionalProperties: false });
export const thinkingSchema = Type.Union(
  (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map(
    (value) => Type.Literal(value),
  ),
);
const nonNegative = Type.Integer({ minimum: 0 });
export const profileSchema = object({
  provider: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
  thinking: Type.Optional(thinkingSchema),
});
export const settingsSchema = object({
  version: Type.Literal(1),
  defaultProfile: Type.Optional(Type.String({ minLength: 1 })),
  profiles: Type.Optional(Type.Record(Type.String(), profileSchema)),
  logLevel: Type.Optional(
    Type.Union(
      (["debug", "info", "warn", "error", "silent"] as const).map((value) =>
        Type.Literal(value),
      ),
    ),
  ),
  compaction: Type.Optional(
    object({
      enabled: Type.Optional(Type.Boolean()),
      reserveTokens: Type.Optional(nonNegative),
      keepRecentTokens: Type.Optional(nonNegative),
      backgroundTokens: Type.Optional(nonNegative),
    }),
  ),
  retry: Type.Optional(
    object({
      enabled: Type.Optional(Type.Boolean()),
      maxRetries: Type.Optional(nonNegative),
      baseDelayMs: Type.Optional(nonNegative),
      maxAgentDelayMs: Type.Optional(nonNegative),
    }),
  ),
  stream: Type.Optional(
    object({
      transport: Type.Optional(
        Type.Union(
          (["sse", "websocket", "websocket-cached", "auto"] as const).map(
            (value) => Type.Literal(value),
          ),
        ),
      ),
      timeoutMs: Type.Optional(nonNegative),
      maxRetries: Type.Optional(nonNegative),
      maxRetryDelayMs: Type.Optional(nonNegative),
      cacheRetention: Type.Optional(
        Type.Union(
          (["none", "short", "long"] as const).map((value) =>
            Type.Literal(value),
          ),
        ),
      ),
    }),
  ),
});
export type WorkspaceSettings = Static<typeof settingsSchema>;
export type ModelProfile = {
  provider: string;
  model: string;
  thinking?: import("../pi/types.ts").ThinkingLevel;
};

export function readWorkspaceSettings(cwd: string): WorkspaceSettings {
  const path = join(workspacePaths(cwd).config, "settings.json");
  const settings = readJson(path, settingsSchema, { version: 1 });
  if (
    settings.defaultProfile &&
    !Object.hasOwn(settings.profiles ?? {}, settings.defaultProfile)
  )
    throw new Error(
      `Unknown defaultProfile ${settings.defaultProfile} in ${path}`,
    );
  return settings;
}
