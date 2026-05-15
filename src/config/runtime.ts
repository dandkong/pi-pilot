import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ConfigOverrides, type LogLevel, resolveConfigValues } from "./schema.ts";

export type RuntimeConfig = {
  telegramToken: string;
  workspaces: string[];
  allowedTelegramUsers: string[];
  logLevel: LogLevel;
};

export function loadConfig(overrides: ConfigOverrides = {}): RuntimeConfig {
  const values = resolveConfigValues(overrides);
  const telegramToken = requiredValue(values.telegramToken, "TELEGRAM_BOT_TOKEN");

  return {
    telegramToken,
    workspaces: parseWorkspaces(values.workspaces),
    allowedTelegramUsers: parseList(values.allowedTelegramUsers),
    logLevel: requiredValue(values.logLevel, "PI_PILOT_LOG_LEVEL") as LogLevel,
  };
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function assertDirectory(path: string, envName: string): void {
  if (!existsSync(path)) throw new Error(`${envName} does not exist: ${path}`);
  if (!statSync(path).isDirectory()) throw new Error(`${envName} is not a directory: ${path}`);
}

function parseList(value: string | undefined): string[] {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

function parseWorkspaces(value: string | undefined): string[] {
  const paths = parseList(value).map((item) => resolve(item));
  const uniquePaths = [...new Set(paths.length ? paths : [process.cwd()])];

  for (const path of uniquePaths) {
    assertDirectory(path, "PI_PILOT_WORKSPACES");
  }

  return uniquePaths;
}
