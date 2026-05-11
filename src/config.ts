import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type AppConfig = {
  telegramToken: string;
  cwd: string;
  workspaces: string[];
  allowedTelegramUsers: string[];
};

export function loadConfig(): AppConfig {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!telegramToken) throw new Error("Missing TELEGRAM_BOT_TOKEN. Set it in .env or your shell environment.");

  const cwd = resolve(process.env.PI_PILOT_CWD?.trim() || process.cwd());
  assertDirectory(cwd, "PI_PILOT_CWD");

  return {
    telegramToken,
    cwd,
    workspaces: parseWorkspaces(process.env.PI_PILOT_WORKSPACES, cwd),
    allowedTelegramUsers: parseList(process.env.TELEGRAM_ALLOWED_USERS),
  };
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

function parseWorkspaces(value: string | undefined, defaultCwd: string): string[] {
  const paths = [defaultCwd, ...parseList(value).map((item) => resolve(item))];
  const uniquePaths = [...new Set(paths)];

  for (const path of uniquePaths) {
    assertDirectory(path, path === defaultCwd ? "PI_PILOT_CWD" : "PI_PILOT_WORKSPACES");
  }

  return uniquePaths;
}
