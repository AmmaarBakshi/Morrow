/**
 * Structured JSON logging with redaction. Contact data and message content
 * must never reach logs: e-mail addresses are masked and sensitive keys
 * (passwords, tokens, html, text, secrets) are dropped.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEYS = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|html|text|body|csv|signature|credential/i;
const EMAIL_RE = /([a-zA-Z0-9._%+-])[a-zA-Z0-9._%+-]*@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[depth]';
  if (typeof value === 'string') return value.replace(EMAIL_RE, '$1***@$2').slice(0, 2000);
  if (value instanceof Error) return { name: value.name, message: String(redact(value.message, depth + 1)) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface JsonLoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  write?: (line: string) => void;
  base?: LogFields;
}

export function createLogger(options: JsonLoggerOptions = {}): Logger {
  const min = LEVELS[options.level ?? 'info'];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const base = options.base ?? {};
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVELS[level] < min) return;
    const record = { time: new Date().toISOString(), level, msg, ...(redact({ ...base, ...fields }) as LogFields) };
    if (options.pretty) {
      const { time, level: l, msg: m, ...rest } = record;
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      write(`${time.slice(11, 19)} ${l.toUpperCase().padEnd(5)} ${m}${extra}`);
    } else {
      write(JSON.stringify(record));
    }
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
