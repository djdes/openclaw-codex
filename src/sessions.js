import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createSessionStore({ path }) {
  mkdirSync(dirname(path), { recursive: true });
  let data = {};
  if (existsSync(path)) {
    try { data = JSON.parse(readFileSync(path, 'utf8')); }
    catch { data = {}; }
  }

  function persist() {
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }

  return {
    get(chatId) { return data[String(chatId)] ?? null; },
    set(chatId, sessionId) { data[String(chatId)] = sessionId; persist(); },
    delete(chatId) { delete data[String(chatId)]; persist(); }
  };
}
