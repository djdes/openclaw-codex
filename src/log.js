import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export function createLogger({ dir }) {
  mkdirSync(dir, { recursive: true });
  function write(level, msg, extra = {}) {
    const ts = new Date().toISOString();
    const line = JSON.stringify({ ts, level, msg, ...extra }) + '\n';
    const date = ts.slice(0, 10);
    appendFileSync(join(dir, `${date}.log`), line);
    if (level === 'error') process.stderr.write(line);
    else process.stdout.write(line);
  }
  return {
    info: (msg, extra) => write('info', msg, extra),
    warn: (msg, extra) => write('warn', msg, extra),
    error: (msg, extra) => write('error', msg, extra),
    debug: (msg, extra) => write('debug', msg, extra),
    flushSync: () => {} // no-op; appendFileSync is synchronous
  };
}
