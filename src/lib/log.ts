export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

function emit(level: string, msg: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const consoleLogger: Logger = {
  info: (m, meta) => emit('info', m, meta),
  warn: (m, meta) => emit('warn', m, meta),
  error: (m, meta) => emit('error', m, meta),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Remove anything that looks like a bot token from an error message before logging/storing it. */
export function redact(text: string): string {
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>').replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '<redacted>');
}
