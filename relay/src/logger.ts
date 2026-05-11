/**
 * Pluggable logger. Default is ConsoleLogger (NDJSON to stdout/stderr);
 * embedders can supply their own Logger implementation to ship structured
 * events elsewhere.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

export class ConsoleLogger implements Logger {
  constructor(private readonly minLevel: LogLevel = "info") {}

  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    };
    const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
    out.write(JSON.stringify(line) + "\n");
  }
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
