import { Bot } from 'grammy';
import { runCodex, extractTextDelta, extractSessionId, extractTaskComplete } from './codex.js';
import { downloadAttachment, scheduleCleanup, reactSafe } from './attachments.js';

const HELP_TEXT = `Codex-powered Клауд bridge.

Команды:
/reset — забыть текущую сессию (новый контекст с следующего сообщения)
/status — статус процесса
/whoami — кратко представиться

Поддерживаемые вложения: фото, документы (PDF/DOCX/TXT/CSV/JSON/любые), голосовые, аудио, видео, видеосообщения. Файл скачивается и Codex читает его инструментами в workspace.`;

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
    await reactSafe(ctx, '👀');
    await handleMessage(ctx, 'Представься коротко в одну строку.');
  });

  bot.on('message:text', async (ctx) => {
    if (!isAllowed(ctx)) return;
    if (ctx.message.text.startsWith('/')) return;
    await reactSafe(ctx, '👀');
    await handleMessage(ctx, ctx.message.text);
  });

  bot.on('message:photo', async (ctx) => {
    if (!isAllowed(ctx)) return;
    await reactSafe(ctx, '👀');
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const caption = ctx.message.caption || 'Что на изображении? Опиши кратко.';
    let path;
    try {
      ({ path } = await downloadAttachment(ctx, largest.file_id, { botToken: config.telegram.botToken, hint: 'photo.jpg' }));
    } catch (e) {
      log.error('photo download failed', { err: e.message, chatId: ctx.chat.id });
      await ctx.reply(`⚠️ Не смог скачать фото: ${e.message}`).catch(() => {});
      return;
    }
    await handleMessage(ctx, caption, [path]);
    scheduleCleanup(path);
  });

  bot.on('message:document', async (ctx) => {
    if (!isAllowed(ctx)) return;
    await reactSafe(ctx, '👀');
    const doc = ctx.message.document;
    let path, sizeBytes;
    try {
      ({ path, sizeBytes } = await downloadAttachment(ctx, doc.file_id, { botToken: config.telegram.botToken, hint: doc.file_name }));
    } catch (e) {
      log.error('document download failed', { err: e.message, chatId: ctx.chat.id });
      await ctx.reply(`⚠️ Не смог скачать документ: ${e.message}`).catch(() => {});
      return;
    }
    const userPrompt = ctx.message.caption || 'Изучи присланный файл и ответь по нему. Если не уверен в формате — определи по расширению/содержимому и используй подходящий инструмент.';
    const prompt = `${userPrompt}

Файл сохранён локально: ${path}
Имя: ${doc.file_name || '(без имени)'}
MIME: ${doc.mime_type || '(неизвестен)'}
Размер: ${sizeBytes} байт

Прочитай файл подходящим способом (Get-Content для текста, node ${config.codex.workspaceDir}\\extract_pdf.mjs для PDF, и т.д.) и ответь.`;
    await handleMessage(ctx, prompt);
    scheduleCleanup(path);
  });

  bot.on('message:voice', async (ctx) => {
    if (!isAllowed(ctx)) return;
    await reactSafe(ctx, '👀');
    const voice = ctx.message.voice;
    let path;
    try {
      ({ path } = await downloadAttachment(ctx, voice.file_id, { botToken: config.telegram.botToken, hint: 'voice.ogg' }));
    } catch (e) {
      log.error('voice download failed', { err: e.message, chatId: ctx.chat.id });
      await ctx.reply(`⚠️ Не смог скачать голос: ${e.message}`).catch(() => {});
      return;
    }
    const prompt = `Пользователь прислал голосовое сообщение (длительность ${voice.duration}с).

Файл: ${path}

Транскрибируй его (через Whisper — в workspace есть установка) и отвечай по содержанию. Если транскрипция требует подтверждения — сначала покажи распознанный текст.`;
    await handleMessage(ctx, prompt);
    scheduleCleanup(path);
  });

  bot.on('message:audio', async (ctx) => {
    if (!isAllowed(ctx)) return;
    await reactSafe(ctx, '👀');
    const audio = ctx.message.audio;
    let path;
    try {
      ({ path } = await downloadAttachment(ctx, audio.file_id, { botToken: config.telegram.botToken, hint: audio.file_name || 'audio' }));
    } catch (e) {
      log.error('audio download failed', { err: e.message, chatId: ctx.chat.id });
      await ctx.reply(`⚠️ Не смог скачать аудио: ${e.message}`).catch(() => {});
      return;
    }
    const userPrompt = ctx.message.caption || 'Аудиозапись. Транскрибируй и отвечай по содержанию.';
    const prompt = `${userPrompt}

Файл: ${path}
Имя: ${audio.file_name || '(без имени)'}
Длительность: ${audio.duration}с
Исполнитель: ${audio.performer || '(нет)'}, название: ${audio.title || '(нет)'}`;
    await handleMessage(ctx, prompt);
    scheduleCleanup(path);
  });

  bot.on('message:video', async (ctx) => {
    if (!isAllowed(ctx)) return;
    await reactSafe(ctx, '👀');
    const video = ctx.message.video;
    let path;
    try {
      ({ path } = await downloadAttachment(ctx, video.file_id, { botToken: config.telegram.botToken, hint: video.file_name || 'video.mp4' }));
    } catch (e) {
      log.error('video download failed', { err: e.message, chatId: ctx.chat.id });
      await ctx.reply(`⚠️ Не смог скачать видео: ${e.message}`).catch(() => {});
      return;
    }
    const userPrompt = ctx.message.caption || 'Видеосообщение. Опиши содержание (если нужна транскрипция аудио — извлеки через ffmpeg + Whisper).';
    const prompt = `${userPrompt}

Файл: ${path}
Длительность: ${video.duration}с, ${video.width}x${video.height}`;
    await handleMessage(ctx, prompt);
    scheduleCleanup(path);
  });

  bot.on('message:video_note', async (ctx) => {
    if (!isAllowed(ctx)) return;
    await reactSafe(ctx, '👀');
    const vn = ctx.message.video_note;
    let path;
    try {
      ({ path } = await downloadAttachment(ctx, vn.file_id, { botToken: config.telegram.botToken, hint: 'circle_video.mp4' }));
    } catch (e) {
      log.error('video_note download failed', { err: e.message, chatId: ctx.chat.id });
      await ctx.reply(`⚠️ Не смог скачать кружок: ${e.message}`).catch(() => {});
      return;
    }
    const prompt = `Пользователь прислал видеосообщение-кружок (${vn.duration}с).

Файл: ${path}

Извлеки аудио (ffmpeg) и транскрибируй (Whisper), затем отвечай по содержанию.`;
    await handleMessage(ctx, prompt);
    scheduleCleanup(path);
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
      await reactSafe(ctx, '💔');
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
      await reactSafe(ctx, '💔');
    } else if (buf.length > 0) {
      await reactSafe(ctx, '👍');
    }
  }

  bot.catch((err) => {
    lastError = `${new Date().toISOString()} ${err.error?.message || err.message}`;
    log.error('grammy uncaught', { err: err.error?.message || err.message });
  });

  return bot;
}
