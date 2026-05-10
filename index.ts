import { TelegramAdapter } from "./src/adapters/telegram.ts";
import { loadConfig } from "./src/config.ts";
import { TELEGRAM_COMMANDS } from "./src/runtime/chat-commands.ts";
import { ChatRuntime } from "./src/runtime/chat-runtime.ts";

const config = loadConfig();
const adapter = new TelegramAdapter(config.telegramToken, TELEGRAM_COMMANDS);
const runtime = new ChatRuntime(config, adapter);

adapter.onMessage((message) => runtime.handleMessage(message));
adapter.onCallback((callback) => runtime.handleCallback(callback));

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}. Stopping Pi Pilot backend...`);
  await adapter.stop().catch((error) => console.error("Failed to stop adapter", error));
  runtime.dispose();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`Pi Pilot backend started. cwd=${config.cwd}`);
await adapter.start();
