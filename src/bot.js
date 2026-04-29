import { Bot } from 'grammy';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodex, extractTextDelta, extractSessionId, extractTaskComplete } from './codex.js';

const IMAGE_TMP_DIR = join(tmpdir(), 'openclaw-codex-images');
const IMAGE_CLEANUP_MS = 5 * 60 * 1000;

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

  bot.on('message:photo', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const caption = ctx.message.caption || 'Что на изображении? Опиши кратко.';

    let tempPath;
    try {
      const file = await ctx.api.getFile(largest.file_id);
      const url = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`download failed HTTP ${response.status}`);
      const buf = Buffer.from(await response.arrayBuffer());
      mkdirSync(IMAGE_TMP_DIR, { recursive: true });
      tempPath = join(IMAGE_TMP_DIR, `${Date.now()}-${largest.file_id}.jpg`);
      writeFileSync(tempPath, buf);
    } catch (e) {
      log.error('failed to download photo', { err: e.message, chatId: ctx.chat.id });
      await ctx.reply(`⚠️ Не смог скачать фото: ${e.message}`).catch(() => {});
      return;
    }

    await handleMessage(ctx, caption, [tempPath]);
    setTimeout(() => { try { unlinkSync(tempPath); } catch {} }, IMAGE_CLEANUP_MS);
  });

  async function handleMessage(ctx, prompt, images = null) {
    const chatId = ctx.chat.id;
    let placeholder;
    try {
      placeholder = await ctx.reply('⌛ думаю…');
    } catch (e) {
      log.error('failed to send placeholder', { err: e.message, chatId });
      return;
    }

    try {
      await queue.enqueue(chatId, () => runOneTurn(ctx, prompt, placeholder.message_id, chatId, images));
    } catch (e) {
      lastError = `${new Date().toISOString()} ${e.message}`;
      log.error('queue rejected', { err: e.message, chatId });
      await ctx.api.editMessageText(chatId, placeholder.message_id, `⚠️ ${e.message}`).catch(() => {});
    }
  }

  async function runOneTurn(ctx, prompt, placeholderId, chatId, images = null) {
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
      images,
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
