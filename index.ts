#!/usr/bin/env bun

import { formatHelp, parseCliArgs, readPackageVersion } from "./src/cli.ts";
import { loadConfig } from "./src/config/runtime.ts";
import { configureLogger } from "./src/logger.ts";

let cli;
try {
  cli = parseCliArgs(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}\nRun pi-pilot --help for usage.`);
  process.exit(1);
}

if (cli.help) {
  console.log(formatHelp());
  process.exit(0);
}

if (cli.version) {
  console.log(readPackageVersion());
  process.exit(0);
}

let config;
try {
  config = loadConfig(cli.config);
  configureLogger(config.logLevel);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}

const [{ TelegramAdapter }, { CHAT_COMMANDS }, { ChatRuntime }] = await Promise.all([
  import("./src/adapters/telegram.ts"),
  import("./src/runtime/chat-commands.ts"),
  import("./src/runtime/chat-runtime.ts"),
]);
const adapter = new TelegramAdapter(config.telegramToken, CHAT_COMMANDS);
const runtime = new ChatRuntime(config, adapter, {
  onExitRequest: () => shutdown("/exit", true),
});

adapter.onMessage((message) => runtime.handleMessage(message));
adapter.onCallback((callback) => runtime.handleCallback(callback));

let shuttingDown = false;
const shutdown = async (signal: string, exit = false) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}. Stopping Pi Pilot backend...`);
  await adapter.stop().catch((error) => console.error("Failed to stop adapter", error));
  await runtime.dispose();
  if (exit) process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

if (config.allowedActorIds.length === 0) {
  console.warn("TELEGRAM_ALLOWED_USERS is empty; all Telegram users will be rejected.");
}

console.log(`Pi Pilot backend started. workspace=${config.workspaces[0]}`);
try {
  await runtime.warmup();
  await adapter.start();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
