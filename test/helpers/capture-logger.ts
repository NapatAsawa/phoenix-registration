import { pino, type Logger } from 'pino';

/** A captured log line, parsed back from pino's JSON output. */
export type LogLine = Record<string, unknown>;

export interface CapturedLogger {
  logger: Logger;
  /** Every line pino wrote, newest last. */
  lines: LogLine[];
  /** Lines carrying a given domain-event name (the `event` field). */
  withEvent: (event: string) => LogLine[];
}

/**
 * A real pino logger whose JSON output is collected into an array, so tests can
 * assert which structured lines — and which domain events (issue #7) — were
 * emitted. pino accepts any destination with a `write(str)`; we parse each line.
 */
export function captureLogger(level = 'info'): CapturedLogger {
  const lines: LogLine[] = [];
  const logger = pino(
    { level },
    {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as LogLine);
      },
    },
  );
  return {
    logger,
    lines,
    withEvent: (event) => lines.filter((l) => l.event === event),
  };
}
