import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/config.js';

function withTempConfig(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, content);
  try { return fn(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('loadConfig: returns parsed object with defaults', () => {
  const minimal = JSON.stringify({
    telegram: { botToken: 'TOK', ownerUserId: 1 },
    codex: { workspaceDir: 'C:/x' }
  });
  withTempConfig(minimal, (path) => {
    const cfg = loadConfig(path);
    assert.equal(cfg.telegram.botToken, 'TOK');
    assert.equal(cfg.telegram.ownerUserId, 1);
    assert.equal(cfg.telegram.streamThrottleMs, 1500); // default
    assert.equal(cfg.telegram.maxQueuePerChat, 3);     // default
    assert.deepEqual(cfg.telegram.allowedGroupIds, []);
    assert.equal(cfg.codex.binary, 'codex');           // default
    assert.equal(cfg.codex.sandbox, 'workspace-write');
    assert.equal(cfg.codex.approval, 'never');
    assert.equal(cfg.codex.execTimeoutMs, 300000);
  });
});

test('loadConfig: throws ConfigError when botToken missing', () => {
  withTempConfig(JSON.stringify({ telegram: { ownerUserId: 1 }, codex: { workspaceDir: 'x' } }), (path) => {
    assert.throws(() => loadConfig(path), ConfigError);
  });
});

test('loadConfig: throws ConfigError when ownerUserId missing', () => {
  withTempConfig(JSON.stringify({ telegram: { botToken: 'T' }, codex: { workspaceDir: 'x' } }), (path) => {
    assert.throws(() => loadConfig(path), ConfigError);
  });
});

test('loadConfig: throws ConfigError when workspaceDir missing', () => {
  withTempConfig(JSON.stringify({ telegram: { botToken: 'T', ownerUserId: 1 }, codex: {} }), (path) => {
    assert.throws(() => loadConfig(path), ConfigError);
  });
});

test('loadConfig: throws ConfigError when file does not exist', () => {
  assert.throws(() => loadConfig('C:/no/such/file.json'), ConfigError);
});

test('loadConfig: throws ConfigError on invalid JSON', () => {
  withTempConfig('{ not json', (path) => {
    assert.throws(() => loadConfig(path), ConfigError);
  });
});
