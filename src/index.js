import { join } from 'node:path';
import { homedir } from 'node:os';
import net from 'node:net';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createSessionStore } from './sessions.js';
import { createQueue } from './queue.js';
import { createBot } from './bot.js';
import { createShimServer } from './chatCompletions.js';

const CONFIG_PATH = process.env.OPENCLAW_CODEX_CONFIG
  || join(homedir(), '.openclaw-codex', 'config.json');
const INSTANCE_LOCK = process.env.OPENCLAW_CODEX_LOCK || '\\\\.\\pipe\\openclaw-codex-bridge';

async function acquireInstanceLock() {
  const server = net.createServer();

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(null);
        return;
      }
      reject(err);
    });
    server.listen(INSTANCE_LOCK, () => resolve(server));
  });
}

async function main() {
  const instanceLock = await acquireInstanceLock();
  if (!instanceLock) {
    console.error('fatal: another openclaw-codex bridge instance is already running');
    process.exit(0);
  }

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

  // Optional: OpenAI-style chat-completions HTTP shim (replaces clawdbot's
  // legacy gateway:18789 so YESBEAT autoresponder etc. keep working).
  let shim = null;
  if (config.chatCompletionsShim?.enabled) {
    shim = createShimServer({
      bearerToken: config.chatCompletionsShim.bearerToken,
      codexConfig: config.codex,
      log
    });
    shim.listen(config.chatCompletionsShim.port, '127.0.0.1', () => {
      log.info('chatCompletions shim listening', { port: config.chatCompletionsShim.port });
    });
  }

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
