import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DEFINITIONS, type ConfigOverrides, createFlagMap } from "./config/schema.ts";

export type CliConfigOverrides = ConfigOverrides;

export type CliOptions = {
  config: CliConfigOverrides;
  help: boolean;
  version: boolean;
};

const FLAG_TO_KEY = createFlagMap();

export function parseCliArgs(args: string[]): CliOptions {
  const config: CliConfigOverrides = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") return { config, help: true, version: false };
    if (arg === "--version" || arg === "-v") return { config, help: false, version: true };

    const separatorIndex = arg.indexOf("=");
    const flag = separatorIndex === -1 ? arg : arg.slice(0, separatorIndex);
    const inlineValue = separatorIndex === -1 ? undefined : arg.slice(separatorIndex + 1);
    const key = FLAG_TO_KEY[flag];
    if (!key) throw new Error(`Unknown option: ${arg}`);

    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }

    config[key] = value;
    if (inlineValue === undefined) index += 1;
  }

  return { config, help: false, version: false };
}

export function formatHelp(): string {
  const optionRows = CONFIG_DEFINITIONS.map((definition) => {
    const flags = definition.flags.map((flag) => `${flag} <${definition.valueName}>`).join(", ");
    return `  ${flags.padEnd(43)} ${definition.description} (${definition.env})`;
  }).join("\n");

  return `Pi Pilot - Telegram bot wrapper for pi coding agent

Usage:
  pi-pilot [options]

Options:
${optionRows}
  -h, --help${"".padEnd(34)} Show this help
  -v, --version${"".padEnd(31)} Show package version

Environment variables are still supported. CLI options take precedence.`;
}

export function readPackageVersion(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(currentDir, "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
  return packageJson.version ?? "0.0.0";
}
