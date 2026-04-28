import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/log.js';

test('createLogger: writes JSON line per call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-log-'));
  try {
    const log = createLogger({ dir });
    log.info('hello', { foo: 1 });
    log.error('bad', { code: 42 });
    log.flushSync();
    const date = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(dir, `${date}.log`), 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);
    const a = JSON.parse(lines[0]);
    assert.equal(a.level, 'info');
    assert.equal(a.msg, 'hello');
    assert.equal(a.foo, 1);
    assert.match(a.ts, /^\d{4}-\d{2}-\d{2}T/);
    const b = JSON.parse(lines[1]);
    assert.equal(b.level, 'error');
    assert.equal(b.code, 42);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createLogger: rotates file by date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-log-'));
  try {
    const log = createLogger({ dir });
    log.info('today');
    log.flushSync();
    const date = new Date().toISOString().slice(0, 10);
    assert.ok(readFileSync(join(dir, `${date}.log`), 'utf8').includes('today'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
