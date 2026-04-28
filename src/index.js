import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createSessionStore } from './sessions.js';
import { createQueue } from './queue.js';
import { createBot } from './bot.js';

const CONFIG_PATH = process.env.OPENCLAW_CODEX_CONFIG
  || join(homedir(), '.openclaw-codex', 'config.json');

async function main() {
  const config = loadConfig(CONFIG_PATH);
  const log = createLogger({ dir: config.logging.dir });
  log.info('starting', { configPath: CONFIG_PATH, workspace: config.codex.workspaceDir });

  const sessionsPath = config.sessions.storePath
    || join(homedir(), '.openclaw-codex', 'sessions.json');
  const sessions = createSessionStore({ path: sessionsPath });

  const queue = createQueue({ maxQueueDepth: config.telegram.maxQueuePerChat });

  if (config.proxy.https_proxy) {
    process.env.HTTPS_PROXY = config.proxy.https_proxy;
    process.env.NO_PROXY = config.proxy.no_proxy;
    log.info('proxy enabled', { https_proxy: '***', no_proxy: config.proxy.no_proxy });
  }

  const bot = createBot({ config, sessions, queue, log });

  process.on('SIGINT', async () => { log.info('SIGINT — stopping'); await bot.stop(); process.exit(0); });
  process.on('SIGTERM', async () => { log.info('SIGTERM — stopping'); await bot.stop(); process.exit(0); });
  process.on('unhandledRejection', (reason) => { log.error('unhandledRejection', { reason: String(reason) }); });
  process.on('uncaughtException', (err) => { log.error('uncaughtException', { err: err.message, stack: err.stack }); });

  log.info('starting bot polling');
  await bot.start({
    onStart: (info) => log.info('bot started', { username: info.username })
  });
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
