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

test('loadConfig: legacy single-bot (telegram.botToken) is wrapped into bots[0]', () => {
  const minimal = JSON.stringify({
    telegram: { botToken: 'TOK', ownerUserId: 1 },
    codex: { workspaceDir: 'C:/x' }
  });
  withTempConfig(minimal, (path) => {
    const cfg = loadConfig(path);
    assert.equal(cfg.bots.length, 1);
    assert.equal(cfg.bots[0].name, 'primary');
    assert.equal(cfg.bots[0].botToken, 'TOK');
    assert.equal(cfg.bots[0].ownerUserId, 1);
    assert.deepEqual(cfg.bots[0].allowedGroupIds, []);
    assert.deepEqual(cfg.bots[0].allowedUserIds, []);
    assert.equal(cfg.bots[0].rolePrompt, null);
    assert.match(cfg.bots[0].sessionsPath, /sessions-primary\.json$/);
    assert.equal(cfg.telegram.streamThrottleMs, 1500);
    assert.equal(cfg.telegram.maxQueuePerChat, 3);
    assert.equal(cfg.codex.binary, 'codex');
  });
});

test('loadConfig: bots[] array is preferred when present', () => {
  const cfg = JSON.stringify({
    bots: [
      { name: 'primary', botToken: 'A', ownerUserId: 1 },
      { name: 'work', botToken: 'B', ownerUserId: 1, allowedUserIds: [42, 99] }
    ],
    codex: { workspaceDir: 'C:/x' }
  });
  withTempConfig(cfg, (path) => {
    const c = loadConfig(path);
    assert.equal(c.bots.length, 2);
    assert.equal(c.bots[0].name, 'primary');
    assert.equal(c.bots[1].name, 'work');
    assert.deepEqual(c.bots[1].allowedUserIds, [42, 99]);
    assert.match(c.bots[0].sessionsPath, /sessions-primary\.json$/);
    assert.match(c.bots[1].sessionsPath, /sessions-work\.json$/);
  });
});

test('loadConfig: rolePrompt is preserved per bot', () => {
  const cfg = JSON.stringify({
    bots: [{ name: 'b1', botToken: 'A', ownerUserId: 1, rolePrompt: 'You are Alice.' }],
    codex: { workspaceDir: 'C:/x' }
  });
  withTempConfig(cfg, (path) => {
    const c = loadConfig(path);
    assert.equal(c.bots[0].rolePrompt, 'You are Alice.');
  });
});

test('loadConfig: throws ConfigError when no bots and no telegram', () => {
  withTempConfig(JSON.stringify({ codex: { workspaceDir: 'x' } }), (path) => {
    assert.throws(() => loadConfig(path), ConfigError);
  });
});

test('loadConfig: throws ConfigError when bots[i] missing botToken', () => {
  const cfg = JSON.stringify({
    bots: [{ name: 'b1', ownerUserId: 1 }],
    codex: { workspaceDir: 'x' }
  });
  withTempConfig(cfg, (path) => {
    assert.throws(() => loadConfig(path), ConfigError);
  });
});

test('loadConfig: throws ConfigError when bots[i] missing ownerUserId', () => {
  const cfg = JSON.stringify({
    bots: [{ name: 'b1', botToken: 'A' }],
    codex: { workspaceDir: 'x' }
  });
  withTempConfig(cfg, (path) => {
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
