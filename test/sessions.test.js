import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '../src/sessions.js';

test('createSessionStore: returns null for unknown chat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-sess-'));
  try {
    const store = createSessionStore({ path: join(dir, 'sessions.json') });
    assert.equal(store.get(123), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createSessionStore: set then get returns value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-sess-'));
  try {
    const store = createSessionStore({ path: join(dir, 'sessions.json') });
    store.set(123, 'sess-abc');
    assert.equal(store.get(123), 'sess-abc');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createSessionStore: persists across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-sess-'));
  const path = join(dir, 'sessions.json');
  try {
    createSessionStore({ path }).set(1, 'a');
    const fresh = createSessionStore({ path });
    assert.equal(fresh.get(1), 'a');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createSessionStore: delete removes mapping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-sess-'));
  try {
    const store = createSessionStore({ path: join(dir, 'sessions.json') });
    store.set(1, 'a');
    store.delete(1);
    assert.equal(store.get(1), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createSessionStore: handles corrupt file by starting empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-sess-'));
  const path = join(dir, 'sessions.json');
  writeFileSync(path, '{ corrupt');
  try {
    const store = createSessionStore({ path });
    assert.equal(store.get(1), null);
    store.set(1, 'a');
    assert.equal(store.get(1), 'a');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
