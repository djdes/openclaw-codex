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
  log.info('starting', {
    configPath: CONFIG_PATH,
    workspace: config.codex.workspaceDir,
    bots: config.bots.map(b => b.name)
  });

  // Single shared queue keyed by `<botName>:<chatId>` → safe across bots.
  const queue = createQueue({ maxQueueDepth: config.telegram.maxQueuePerChat });

  if (config.proxy.https_proxy) {
    process.env.HTTPS_PROXY = config.proxy.https_proxy;
    process.env.NO_PROXY = config.proxy.no_proxy;
    log.info('proxy enabled', { https_proxy: '***', no_proxy: config.proxy.no_proxy });
  }

  const botInstances = config.bots.map(botConfig => {
    const sessions = createSessionStore({ path: botConfig.sessionsPath });
    const bot = createBot({
      botConfig,
      codexConfig: config.codex,
      telegramConfig: config.telegram,
      sessions,
      queue,
      log
    });
    return { name: botConfig.name, bot };
  });

  async function stopAll(reason) {
    log.info(`${reason} — stopping all bots`);
    await Promise.allSettled(botInstances.map(({ bot }) => bot.stop()));
    process.exit(0);
  }
  process.on('SIGINT', () => stopAll('SIGINT'));
  process.on('SIGTERM', () => stopAll('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', { err: err.message, stack: err.stack });
  });

  log.info('starting polling for all bots');
  // Start each bot. grammy bot.start() resolves only when bot stops, so launch in parallel.
  await Promise.all(botInstances.map(({ name, bot }) =>
    bot.start({
      onStart: (info) => log.info('bot started', { name, username: info.username })
    }).catch(err => {
      log.error('bot crashed', { name, err: err.message });
      throw err;
    })
  ));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
