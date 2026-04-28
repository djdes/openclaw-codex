import { Bot } from 'grammy';
import { runCodex, extractTextDelta, extractSessionId, extractTaskComplete } from './codex.js';

const HELP_TEXT = `Codex-powered Клауд bridge.

Команды:
/reset — забыть текущую сессию (новый контекст с следующего сообщения)
/status — статус процесса
/whoami — кратко представиться`;

export function createBot({ config, sessions, queue, log }) {
  const bot = new Bot(config.telegram.botToken);
  const startedAt = Date.now();
  let lastError = null;

  function isAllowed(ctx) {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (fromId === config.telegram.ownerUserId) return true;
    if (config.telegram.allowedGroupIds.includes(chatId)) return true;
    return false;
  }

  bot.command('start', async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.reply(HELP_TEXT);
  });

  bot.command('reset', async (ctx) => {
    if (!isAllowed(ctx)) return;
    sessions.delete(ctx.chat.id);
    await ctx.reply('Сессия сброшена. Следующее сообщение начнёт новый контекст.');
  });

  bot.command('status', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
    const sid = sessions.get(ctx.chat.id);
    const msg = [
      `uptime: ${uptimeSec}s`,
      `session: ${sid || '(none)'}`,
      `queue depth: ${queue.depth(ctx.chat.id)}`,
      `last error: ${lastError || '(none)'}`
    ].join('\n');
    await ctx.reply(msg);
  });

  bot.command('whoami', async (ctx) => {
    if (!isAllowed(ctx)) return;
    await handleMessage(ctx, 'Представься коротко в одну строку.');
  });

  bot.on('message:text', async (ctx) => {
    if (!isAllowed(ctx)) return;
    if (ctx.message.text.startsWith('/')) return; // commands handled above
    await handleMessage(ctx, ctx.message.text);
  });

  async function handleMessage(ctx, prompt) {
    const chatId = ctx.chat.id;
    let placeholder;
    try {
      placeholder = await ctx.reply('⌛ думаю…');
    } catch (e) {
      log.error('failed to send placeholder', { err: e.message, chatId });
      return;
    }

    try {
      await queue.enqueue(chatId, () => runOneTurn(ctx, prompt, placeholder.message_id, chatId));
    } catch (e) {
      lastError = `${new Date().toISOString()} ${e.message}`;
      log.error('queue rejected', { err: e.message, chatId });
      await ctx.api.editMessageText(chatId, placeholder.message_id, `⚠️ ${e.message}`).catch(() => {});
    }
  }

  async function runOneTurn(ctx, prompt, placeholderId, chatId) {
    const sessionId = sessions.get(chatId);
    let buf = '';
    let lastEditAt = 0;
    let editPending = null;

    function scheduleEdit() {
      const now = Date.now();
      const delay = Math.max(0, config.telegram.streamThrottleMs - (now - lastEditAt));
      if (editPending) return;
      editPending = setTimeout(async () => {
        editPending = null;
        lastEditAt = Date.now();
        const text = buf.length > 4000 ? buf.slice(0, 4000) + '…' : buf;
        if (text.length === 0) return;
        try { await ctx.api.editMessageText(chatId, placeholderId, text); }
        catch (e) { log.warn('editMessageText failed', { err: e.message }); }
      }, delay);
    }

    let newSessionId = null;
    const result = await runCodex({
      binary: config.codex.binary,
      workspaceDir: config.codex.workspaceDir,
      sandbox: config.codex.sandbox,
      approval: config.codex.approval,
      sessionId,
      prompt,
      timeoutMs: config.codex.execTimeoutMs,
      onEvent: (ev) => {
        const sid = extractSessionId(ev);
        if (sid) newSessionId = sid;
        const delta = extractTextDelta(ev);
        if (delta) { buf += delta; scheduleEdit(); }
        if (extractTaskComplete(ev)) {
          // final flush handled below
        }
      }
    });

    if (editPending) { clearTimeout(editPending); editPending = null; }
    const finalText = buf.length === 0
      ? (result.exitCode === 0 ? '(пустой ответ)' : `⚠️ codex exit ${result.exitCode}\n${result.stderr.slice(0, 500)}`)
      : (buf.length > 4000 ? buf.slice(0, 4000) + '…' : buf);

    try { await ctx.api.editMessageText(chatId, placeholderId, finalText); }
    catch (e) { log.warn('final editMessageText failed', { err: e.message }); }

    if (newSessionId) sessions.set(chatId, newSessionId);

    if (result.exitCode !== 0) {
      lastError = `${new Date().toISOString()} codex exit ${result.exitCode}: ${result.stderr.slice(0, 300)}`;
      log.error('codex exited non-zero', { exitCode: result.exitCode, stderr: result.stderr.slice(0, 1000), chatId });
    }
  }

  bot.catch((err) => {
    lastError = `${new Date().toISOString()} ${err.error?.message || err.message}`;
    log.error('grammy uncaught', { err: err.error?.message || err.message });
  });

  return bot;
}
