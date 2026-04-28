import { readFileSync } from 'node:fs';

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

const DEFAULTS = {
  telegram: {
    allowedGroupIds: [],
    streamThrottleMs: 1500,
    maxQueuePerChat: 3
  },
  codex: {
    binary: 'codex',
    sandbox: 'workspace-write',
    approval: 'never',
    execTimeoutMs: 300000
  },
  sessions: {
    storePath: null
  },
  logging: {
    dir: 'C:\\tmp\\openclaw-codex'
  },
  proxy: {
    https_proxy: null,
    no_proxy: '127.0.0.1,localhost,::1,api.telegram.org'
  }
};

export function loadConfig(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { throw new ConfigError(`Cannot read config at ${path}: ${e.message}`); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new ConfigError(`Invalid JSON in ${path}: ${e.message}`); }

  if (!parsed.telegram?.botToken) throw new ConfigError('telegram.botToken is required');
  if (typeof parsed.telegram?.ownerUserId !== 'number') throw new ConfigError('telegram.ownerUserId is required and must be a number');
  if (!parsed.codex?.workspaceDir) throw new ConfigError('codex.workspaceDir is required');

  return {
    telegram: { ...DEFAULTS.telegram, ...parsed.telegram },
    codex: { ...DEFAULTS.codex, ...parsed.codex },
    sessions: { ...DEFAULTS.sessions, ...(parsed.sessions || {}) },
    logging: { ...DEFAULTS.logging, ...(parsed.logging || {}) },
    proxy: { ...DEFAULTS.proxy, ...(parsed.proxy || {}) }
  };
}
