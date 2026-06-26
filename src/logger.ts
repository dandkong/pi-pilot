import type { LogLevel } from "./config/schema.js";

export type { LogLevel };

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

export class Logger {
  constructor(
    private readonly scope: string,
    private level: LogLevel = "info",
    private readonly previewLimit = 2_000,
  ) {}

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.level, this.previewLimit);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, details?: unknown): void {
    this.write("debug", message, details);
  }

  info(message: string, details?: unknown): void {
    this.write("info", message, details);
  }

  warn(message: string, details?: unknown): void {
    this.write("warn", message, details);
  }

  error(message: string, details?: unknown): void {
    this.write("error", message, details);
  }

  preview(value: unknown, limit = this.previewLimit): string {
    const text = typeof value === "string" ? value : stringify(value);
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}... [truncated ${text.length - limit} chars]`;
  }

  private write(level: Exclude<LogLevel, "silent">, message: string, details?: unknown): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;

    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${this.scope}] ${message}`;
    const output = details === undefined ? line : `${line} ${this.preview(details)}`;
    if (level === "error") {
      console.error(output);
      return;
    }
    if (level === "warn") {
      console.warn(output);
      return;
    }
    console.log(output);
  }
}

export const logger = new Logger("pi-pilot");

export function configureLogger(level: LogLevel): void {
  logger.setLevel(level);
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, createCircularReplacer(), 2);
  } catch {
    return String(value);
  }
}

function createCircularReplacer() {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value;
  };
}
