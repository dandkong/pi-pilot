export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type ConfigKey = "telegramToken" | "workspaces" | "allowedTelegramUsers" | "defaultTelegramChatId" | "logLevel";
export type ConfigOverrides = Partial<Record<ConfigKey, string>>;
export type ResolvedConfigValues = Partial<Record<ConfigKey, string>>;

type ConfigDefinition = {
  key: ConfigKey;
  env: string;
  flags: readonly string[];
  valueName: string;
  description: string;
  required?: boolean;
  defaultValue?: () => string | undefined;
  validate?: (value: string) => void;
};

export const CONFIG_DEFINITIONS: readonly ConfigDefinition[] = [
  {
    key: "telegramToken",
    env: "TELEGRAM_BOT_TOKEN",
    flags: ["--telegram-token", "--bot-token"],
    valueName: "token",
    description: "Telegram bot token",
    required: true,
  },
  {
    key: "workspaces",
    env: "PI_PILOT_WORKSPACES",
    flags: ["--workspaces"],
    valueName: "paths",
    description: "Comma-separated workspace paths",
  },
  {
    key: "allowedTelegramUsers",
    env: "TELEGRAM_ALLOWED_USERS",
    flags: ["--allowed-users"],
    valueName: "ids",
    description: "Comma-separated Telegram user IDs allowed to interact",
  },
  {
    key: "defaultTelegramChatId",
    env: "TELEGRAM_DEFAULT_CHAT_ID",
    flags: ["--default-chat-id"],
    valueName: "chat-id",
    description: "Default Telegram chat ID for all bot output",
  },
  {
    key: "logLevel",
    env: "PI_PILOT_LOG_LEVEL",
    flags: ["--log-level"],
    valueName: "level",
    description: `Log level (${LOG_LEVELS.join("|")})`,
    defaultValue: () => "info",
    validate: (value) => {
      if (!isLogLevel(value)) throw new Error(`Invalid PI_PILOT_LOG_LEVEL: ${value}. Use ${LOG_LEVELS.join(", ")}.`);
    },
  },
];

export function createFlagMap(): Record<string, ConfigKey> {
  const flags: Record<string, ConfigKey> = {};
  for (const definition of CONFIG_DEFINITIONS) {
    for (const flag of definition.flags) flags[flag] = definition.key;
  }
  return flags;
}

export function resolveConfigValues(overrides: ConfigOverrides = {}): ResolvedConfigValues {
  const values: ResolvedConfigValues = {};

  for (const definition of CONFIG_DEFINITIONS) {
    const value = readConfigValue(definition, overrides);
    if (!value) {
      if (definition.required) {
        const flag = definition.flags[0];
        throw new Error(`Missing ${definition.env}. Set it in .env, your shell environment, or pass ${flag}.`);
      }
      continue;
    }

    definition.validate?.(value);
    values[definition.key] = value;
  }

  return values;
}

export function formatConfigHelpRows(): string[] {
  return CONFIG_DEFINITIONS.map((definition) => {
    const flags = definition.flags.map((flag) => `${flag} <${definition.valueName}>`).join(", ");
    return `${flags} | ${definition.env} | ${definition.description}`;
  });
}

export function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.includes(value as LogLevel);
}

function readConfigValue(definition: ConfigDefinition, overrides: ConfigOverrides): string | undefined {
  const override = overrides[definition.key]?.trim();
  if (override) return override;

  const envValue = process.env[definition.env]?.trim();
  if (envValue) return envValue;

  return definition.defaultValue?.();
}
