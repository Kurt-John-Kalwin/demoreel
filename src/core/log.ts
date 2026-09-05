export type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level?: Level;
  json?: boolean;
  sink?: (line: string) => void;
}

/** Small structured logger: one line per event, JSON when DEMOREEL_LOG=json, silent below the level. */
export function createLogger(scope: string, opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? ((process.env.DEMOREEL_LOG_LEVEL as Level | undefined) ?? "info");
  const json = opts.json ?? process.env.DEMOREEL_LOG === "json";
  const sink = opts.sink ?? ((line: string) => process.stderr.write(line + "\n"));
  const emit = (lvl: Level, msg: string, data?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    if (json) {
      sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, scope, msg, ...data }));
      return;
    }
    const extra = data && Object.keys(data).length ? " " + JSON.stringify(data) : "";
    sink(`[${scope}] ${lvl === "info" ? "" : lvl + ": "}${msg}${extra}`);
  };
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
    child: (s) => createLogger(`${scope}:${s}`, { level, json, sink }),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
