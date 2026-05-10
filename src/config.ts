import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type AppConfig = {
  telegramToken: string;
  cwd: string;
};

export function loadConfig(): AppConfig {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!telegramToken) throw new Error("Missing TELEGRAM_BOT_TOKEN. Set it in .env or your shell environment.");

  const cwd = resolve(process.env.PI_PILOT_CWD?.trim() || process.cwd());
  assertDirectory(cwd, "PI_PILOT_CWD");

  return {
    telegramToken,
    cwd,
  };
}

function assertDirectory(path: string, envName: string): void {
  if (!existsSync(path)) throw new Error(`${envName} does not exist: ${path}`);
  if (!statSync(path).isDirectory()) throw new Error(`${envName} is not a directory: ${path}`);
}
