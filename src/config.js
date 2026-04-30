import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

const TELEGRAM_DEFAULTS = {
  streamThrottleMs: 1500,
  maxQueuePerChat: 3
};

const BOT_DEFAULTS = {
  allowedGroupIds: [],
  allowedUserIds: [],
  rolePrompt: null
};

const DEFAULTS = {
  codex: {
    binary: 'codex',
    sandbox: 'workspace-write',
    approval: 'never',
    execTimeoutMs: 300000
  },
  logging: {
    dir: 'C:\\tmp\\openclaw-codex'
  },
  proxy: {
    https_proxy: null,
    no_proxy: '127.0.0.1,localhost,::1,api.telegram.org'
  }
};

function defaultSessionsPath(botName) {
  return join(homedir(), '.openclaw-codex', `sessions-${botName}.json`);
}

function normalizeBot(raw, idx) {
  const name = raw.name || (idx === 0 ? 'primary' : `bot${idx}`);
  if (!raw.botToken) throw new ConfigError(`bots[${idx}] (${name}): botToken is required`);
  if (typeof raw.ownerUserId !== 'number') {
    throw new ConfigError(`bots[${idx}] (${name}): ownerUserId is required and must be a number`);
  }
  return {
    name,
    botToken: raw.botToken,
    ownerUserId: raw.ownerUserId,
    allowedGroupIds: raw.allowedGroupIds ?? BOT_DEFAULTS.allowedGroupIds,
    allowedUserIds: raw.allowedUserIds ?? BOT_DEFAULTS.allowedUserIds,
    rolePrompt: raw.rolePrompt ?? BOT_DEFAULTS.rolePrompt,
    sessionsPath: raw.sessionsPath || defaultSessionsPath(name)
  };
}

export function loadConfig(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { throw new ConfigError(`Cannot read config at ${path}: ${e.message}`); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new ConfigError(`Invalid JSON in ${path}: ${e.message}`); }

  if (!parsed.codex?.workspaceDir) throw new ConfigError('codex.workspaceDir is required');

  // Multi-bot: prefer `bots: [...]` array. Backward-compat: wrap legacy `telegram` single-bot into bots[0].
  let bots;
  if (Array.isArray(parsed.bots) && parsed.bots.length > 0) {
    bots = parsed.bots.map((b, i) => normalizeBot(b, i));
  } else if (parsed.telegram?.botToken) {
    bots = [normalizeBot({ ...parsed.telegram, name: 'primary' }, 0)];
  } else {
    throw new ConfigError('config requires either bots[] array or telegram.botToken (legacy)');
  }

  const telegram = {
    ...TELEGRAM_DEFAULTS,
    streamThrottleMs: parsed.telegram?.streamThrottleMs ?? TELEGRAM_DEFAULTS.streamThrottleMs,
    maxQueuePerChat: parsed.telegram?.maxQueuePerChat ?? TELEGRAM_DEFAULTS.maxQueuePerChat
  };

  return {
    bots,
    telegram,
    codex: { ...DEFAULTS.codex, ...parsed.codex },
    logging: { ...DEFAULTS.logging, ...(parsed.logging || {}) },
    proxy: { ...DEFAULTS.proxy, ...(parsed.proxy || {}) }
  };
}
