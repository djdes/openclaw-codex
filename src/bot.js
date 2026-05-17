import { Bot } from 'grammy';
import { runCodex, extractTextDelta, extractSessionId, extractTaskComplete, extractActivity, extractUsage } from './codex.js';

const PROGRESS_INTERVAL_MS = 8000;
import { downloadAttachment, scheduleCleanup, reactSafe } from './attachments.js';

const HELP_TEXT = `Codex-powered Клауд bridge.

Сессия:
/reset, /new — забыть текущую сессию (новый контекст со следующего сообщения)
/stop — прервать текущий запуск Codex
/compact — попросить агента сжать контекст
/btw <вопрос> — задать побочный вопрос вне основной сессии (не сохраняется)

Опции:
/think [low|medium|high] — уровень reasoning effort (без аргумента — показать текущий)
/usage — счётчики токенов и приблизительная цена за эту сессию
/skill <имя> <ввод> — попросить агента применить именованный навык

Статус:
/status — статус процесса
/whoami — chat/user id
/commands, /help — список команд

Поддерживаемые вложения: фото, документы (PDF/DOCX/TXT/CSV/JSON/любые), голосовые, аудио, видео, видеосообщения.`;

const KNOWN_COMMANDS = new Set([
  'start', 'help', 'commands',
  'reset', 'new', 'stop', 'compact', 'btw',
  'think', 'usage', 'skill',
  'status', 'whoami'
]);

const REASONING_LEVELS = new Set(['low', 'medium', 'high']);

// Bot menu: shown when user types `/` in Telegram. Telegram limits to 100 commands;
// we're well under. Order = display order.
const BOT_MENU_COMMANDS = [
  { command: 'help',     description: 'Список команд' },
  { command: 'reset',    description: 'Сбросить сессию' },
  { command: 'stop',     description: 'Прервать текущий запуск' },
  { command: 'think',    description: 'Уровень reasoning (low/medium/high)' },
  { command: 'usage',    description: 'Счётчики токенов' },
  { command: 'btw',      description: 'Побочный вопрос вне сессии' },
  { command: 'compact',  description: 'Сжать контекст' },
  { command: 'skill',    description: 'Применить именованный навык' },
  { command: 'status',   description: 'Статус процесса' },
  { command: 'whoami',   description: 'Показать ваш id' }
];

/**
 * Build a single Telegram bot instance bound to one bot config.
 *
 * @param {object} args
 * @param {object} args.botConfig    — per-bot fields: name, botToken, ownerUserId, allowedUserIds, allowedGroupIds, rolePrompt, sessionsPath
 * @param {object} args.codexConfig  — shared codex backend settings
 * @param {object} args.telegramConfig — shared throttling/queue
 * @param {object} args.sessions     — session store (one per bot)
 * @param {object} args.queue        — shared queue (per-chat keys are unique across bots)
 * @param {object} args.log          — logger
 */
export function createBot({ botConfig, codexConfig, telegramConfig, sessions, queue, log }) {
  const bot = new Bot(botConfig.botToken);
  const startedAt = Date.now();
  let lastError = null;

  // Per-chat-key in-memory state. None of this persists across restarts —
  // intentional: reasoning preference and usage counters are session-scoped.
  const runningChildren = new Map();   // key -> ChildProcess (current codex run)
  const abortFlags = new Map();        // key -> true when /stop was issued
  const prefs = new Map();             // key -> { reasoningEffort?: 'low'|'medium'|'high' }
  const usage = new Map();             // key -> { input, cachedInput, output, reasoning, turns }

  function isAllowed(ctx) {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (fromId === botConfig.ownerUserId) return true;
    if (botConfig.allowedUserIds.includes(fromId)) return true;
    if (botConfig.allowedGroupIds.includes(chatId)) return true;
    return false;
  }

  // Compose the chat-id key as <botName>:<chatId> so two bots talking to the same user
  // don't share session/queue state.
  function key(chatId) { return `${botConfig.name}:${chatId}`; }

  function decoratePrompt(userPrompt) {
    if (!botConfig.rolePrompt) return userPrompt;
    return `[Bridge: ${botConfig.rolePrompt}]\n\n${userPrompt}`;
  }

  function accumulateUsage(k, u) {
    const cur = usage.get(k) || { input: 0, cachedInput: 0, output: 0, reasoning: 0, turns: 0 };
    cur.input += u.input_tokens;
    cur.cachedInput += u.cached_input_tokens;
    cur.output += u.output_tokens;
    cur.reasoning += u.reasoning_output_tokens;
    cur.turns += 1;
    usage.set(k, cur);
  }

  bot.command(['start', 'help', 'commands'], async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.reply(HELP_TEXT);
  });

  bot.command(['reset', 'new'], async (ctx) => {
    if (!isAllowed(ctx)) return;
    const k = key(ctx.chat.id);
    sessions.delete(k);
    usage.delete(k);
    await ctx.reply('Сессия сброшена. Счётчики обнулены. Следующее сообщение начнёт новый контекст.');
  });

  bot.command('status', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const k = key(ctx.chat.id);
    const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
    const sid = sessions.get(k);
    const pref = prefs.get(k);
    const running = runningChildren.has(k) ? 'yes' : 'no';
    const msg = [
      `bot: ${botConfig.name}`,
      `uptime: ${uptimeSec}s`,
      `session: ${sid || '(none)'}`,
      `reasoning: ${pref?.reasoningEffort || '(default)'}`,
      `running: ${running}`,
      `queue depth: ${queue.depth(k)}`,
      `last error: ${lastError || '(none)'}`
    ].join('\n');
    await ctx.reply(msg);
  });

  bot.command('whoami', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const u = ctx.from;
    const c = ctx.chat;
    const lines = [
      `bot: ${botConfig.name}`,
      `user: ${u?.id} (@${u?.username || '-'}) ${u?.first_name || ''} ${u?.last_name || ''}`.trim(),
      `chat: ${c?.id} (${c?.type})${c?.title ? ' "' + c.title + '"' : ''}`,
      `is_owner: ${u?.id === botConfig.ownerUserId ? 'yes' : 'no'}`
    ];
    await ctx.reply(lines.join('\n'));
  });

  bot.command('stop', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const k = key(ctx.chat.id);
    const child = runningChildren.get(k);
    if (!child) {
      await ctx.reply('Сейчас ничего не выполняется.');
      return;
    }
    abortFlags.set(k, true);
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await ctx.reply('⛔ останавливаю текущий запуск…');
  });

  bot.command('think', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const k = key(ctx.chat.id);
    const arg = (ctx.match || '').trim().toLowerCase();
    if (!arg) {
      const cur = prefs.get(k)?.reasoningEffort || '(default — из ~/.codex/config.toml)';
      await ctx.reply(`reasoning effort: ${cur}\nДоступно: low, medium, high. Использование: /think high`);
      return;
    }
    if (arg === 'default' || arg === 'off' || arg === 'reset') {
      const cur = prefs.get(k) || {};
      delete cur.reasoningEffort;
      prefs.set(k, cur);
      await ctx.reply('reasoning effort: сброшен на дефолт');
      return;
    }
    if (!REASONING_LEVELS.has(arg)) {
      await ctx.reply(`Неизвестный уровень: ${arg}. Доступно: low, medium, high, default.`);
      return;
    }
    const cur = prefs.get(k) || {};
    cur.reasoningEffort = arg;
    prefs.set(k, cur);
    await ctx.reply(`reasoning effort: ${arg} (применяется к следующему запросу)`);
  });

  bot.command('usage', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const k = key(ctx.chat.id);
    const u = usage.get(k);
    if (!u || u.turns === 0) {
      await ctx.reply('За эту сессию ещё не было ни одного хода (или сессия только что сброшена).');
      return;
    }
    const totalIn = u.input;
    const fresh = u.input - u.cachedInput;
    await ctx.reply([
      `Использование за текущую сессию (${u.turns} ходов):`,
      `  input:     ${totalIn} (cached: ${u.cachedInput}, fresh: ${fresh})`,
      `  output:    ${u.output}`,
      `  reasoning: ${u.reasoning}`,
      ``,
      `(Биллинг — по подписке ChatGPT, прямой стоимости в токенах нет.)`
    ].join('\n'));
  });

  bot.command('btw', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const question = (ctx.match || '').trim();
    if (!question) {
      await ctx.reply('Использование: /btw <вопрос>. Запрос пойдёт вне основной сессии и не сохранится.');
      return;
    }
    await handleMessage(ctx, question, null, { ephemeral: true });
  });

  bot.command('compact', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const extra = (ctx.match || '').trim();
    const prompt = extra
      ? `Сожми и подытожь весь предыдущий контекст разговора в краткой форме (ключевые факты, договорённости, открытые задачи). Дополнительные инструкции: ${extra}`
      : 'Сожми и подытожь весь предыдущий контекст разговора в краткой форме (ключевые факты, договорённости, открытые задачи). Этот ответ заменит детальную историю.';
    await handleMessage(ctx, prompt);
  });

  bot.command('skill', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const arg = (ctx.match || '').trim();
    if (!arg) {
      await ctx.reply('Использование: /skill <имя> [ввод]. Пример: /skill brainstorming придумай идеи для X.');
      return;
    }
    const [name, ...rest] = arg.split(/\s+/);
    const input = rest.join(' ').trim();
    const prompt = input
      ? `Примени навык "${name}" со следующим вводом:\n${input}`
      : `Примени навык "${name}".`;
    await handleMessage(ctx, prompt);
  });

  bot.on('message:text', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const text = ctx.message.text;
    if (text.startsWith('/')) {
      // Strip optional `@botname` suffix and arguments, normalize.
      const m = text.match(/^\/([a-zA-Z0-9_]+)/);
      const cmd = m ? m[1].toLowerCase() : '';
      if (!KNOWN_COMMANDS.has(cmd)) {
        await ctx.reply(`Неизвестная команда /${cmd}. Список: /help`).catch(() => {});
      }
      // Known commands are handled by bot.command(...) handlers above —
      // no further action needed here.
      return;
    }
    await handleMessage(ctx, text);
  });

  bot.on('message:photo', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const caption = ctx.message.caption || 'Что на изображении? Опиши кратко.';
    let path;
    try {
      ({ path } = await downloadAttachment(ctx, largest.file_id, { botToken: botConfig.botToken, hint: 'photo.jpg' }));
    } catch (e) {
      log.error('photo download failed', { err: e.message, bot: botConfig.name, chatId: ctx.chat.id });
      await ctx.reply(`⚠️ Не смог скачать фото: ${e.message}`).catch(() => {});
      return;
    }
    await handleMessage(ctx, caption, [path]);
    scheduleCleanup(path);
  });

  bot.on('message:document', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const doc = ctx.message.document;
    let path, sizeBytes;
    try {
      ({ path, sizeBytes } = await downloadAttachment(ctx, doc.file_id, { botToken: botConfig.botToken, hint: doc.file_name }));
    } catch (e) {
      log.error('document download failed', { err: e.message, bot: botConfig.name, chatId: ctx.chat.id });
      await ctx.reply(`⚠️ Не смог скачать документ: ${e.message}`).catch(() => {});
      return;
    }
    const userPrompt = ctx.message.caption || 'Изучи присланный файл и ответь по нему.';
    const prompt = `${userPrompt}

Файл сохранён локально: ${path}
Имя: ${doc.file_name || '(без имени)'}
MIME: ${doc.mime_type || '(неизвестен)'}
Размер: ${sizeBytes} байт

Прочитай файл подходящим способом (Codex skills pdf/doc/spreadsheet, Get-Content для текста и т.д.) и ответь.`;
    await handleMessage(ctx, prompt);
    scheduleCleanup(path);
  });

  bot.on('message:voice', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const voice = ctx.message.voice;
    let path;
    try {
      ({ path } = await downloadAttachment(ctx, voice.file_id, { botToken: botConfig.botToken, hint: 'voice.ogg' }));
    } catch (e) {
      log.error('voice download failed', { err: e.message, bot: botConfig.name, chatId: ctx.chat.id });
      await ctx.reply(`⚠️ Не смог скачать голос: ${e.message}`).catch(() => {});
      return;
    }
    const prompt = `Пользователь прислал голосовое сообщение (${voice.duration}с).

Файл: ${path}

Транскрибируй его (Whisper в workspace) и отвечай по содержанию.`;
    await handleMessage(ctx, prompt);
    scheduleCleanup(path);
  });

  bot.on('message:audio', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const audio = ctx.message.audio;
    let path;
    try {
      ({ path } = await downloadAttachment(ctx, audio.file_id, { botToken: botConfig.botToken, hint: audio.file_name || 'audio' }));
    } catch (e) {
      log.error('audio download failed', { err: e.message, bot: botConfig.name, chatId: ctx.chat.id });
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
    const video = ctx.message.video;
    let path;
    try {
      ({ path } = await downloadAttachment(ctx, video.file_id, { botToken: botConfig.botToken, hint: video.file_name || 'video.mp4' }));
    } catch (e) {
      log.error('video download failed', { err: e.message, bot: botConfig.name, chatId: ctx.chat.id });
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
    const vn = ctx.message.video_note;
    let path;
    try {
      ({ path } = await downloadAttachment(ctx, vn.file_id, { botToken: botConfig.botToken, hint: 'circle_video.mp4' }));
    } catch (e) {
      log.error('video_note download failed', { err: e.message, bot: botConfig.name, chatId: ctx.chat.id });
      await ctx.reply(`⚠️ Не смог скачать кружок: ${e.message}`).catch(() => {});
      return;
    }
    const prompt = `Пользователь прислал видеосообщение-кружок (${vn.duration}с).

Файл: ${path}

Извлеки аудио (ffmpeg) и транскрибируй (Whisper), затем отвечай по содержанию.`;
    await handleMessage(ctx, prompt);
    scheduleCleanup(path);
  });

  async function handleMessage(ctx, rawPrompt, images = null, options = {}) {
    const chatId = ctx.chat.id;
    const k = key(chatId);
    const prompt = decoratePrompt(rawPrompt);
    let placeholder;
    try {
      placeholder = await ctx.reply('⌛ думаю…');
    } catch (e) {
      log.error('failed to send placeholder', { err: e.message, bot: botConfig.name, chatId });
      return;
    }

    try {
      await queue.enqueue(k, () => runOneTurn(ctx, prompt, placeholder.message_id, chatId, k, images, options));
    } catch (e) {
      lastError = `${new Date().toISOString()} ${e.message}`;
      log.error('queue rejected', { err: e.message, bot: botConfig.name, chatId });
      await ctx.api.editMessageText(chatId, placeholder.message_id, `⚠️ ${e.message}`).catch(() => {});
    }
  }

  function extractReaction(text) {
    const m = text.match(/\[react:([^\]]+)\]/i);
    if (!m) return { emoji: null, cleaned: text };
    return {
      emoji: m[1].trim(),
      cleaned: text.replace(/\[react:[^\]]+\]/gi, '').trim()
    };
  }

  // Split a long reply into multiple Telegram messages.
  //   1) Honor explicit `\n---\n` markers from the agent (each becomes its own message).
  //   2) Otherwise, if the reply is long (>1500 chars) AND has paragraph breaks,
  //      auto-chunk on `\n\n` boundaries to ~1500 chars per message.
  //   3) Hard-cap each chunk at 4000 chars (Telegram's limit is 4096).
  function splitReply(text) {
    const explicit = text.split(/\n[ \t]*-{3,}[ \t]*\n/).map(s => s.trim()).filter(Boolean);
    let chunks = explicit.length > 1 ? explicit : [text];

    if (chunks.length === 1 && chunks[0].length > 1500 && chunks[0].includes('\n\n')) {
      const paragraphs = chunks[0].split(/\n\n+/).map(p => p.trim()).filter(Boolean);
      const auto = [];
      let cur = '';
      for (const p of paragraphs) {
        if (cur.length === 0) { cur = p; continue; }
        if ((cur + '\n\n' + p).length > 1500) { auto.push(cur); cur = p; }
        else { cur += '\n\n' + p; }
      }
      if (cur) auto.push(cur);
      chunks = auto;
    }

    return chunks.map(c => c.length > 4000 ? c.slice(0, 4000) + '…' : c);
  }

  async function runOneTurn(ctx, prompt, placeholderId, chatId, sessionKey, images = null, options = {}) {
    const ephemeral = Boolean(options.ephemeral);
    // For ephemeral (/btw) turns, don't resume — these should not see prior context
    // and should not become part of the conversation history.
    const sessionId = ephemeral ? null : sessions.get(sessionKey);
    const reasoningEffort = prefs.get(sessionKey)?.reasoningEffort;
    const startedAt = Date.now();
    let buf = '';
    let lastActivity = '⏳ запускаю';
    let lastShownText = '⌛ думаю…';
    let editPending = null;

    function scheduleEdit() {
      if (editPending) return;
      editPending = setTimeout(async () => {
        editPending = null;
        const text = buf.length > 4000 ? buf.slice(0, 4000) + '…' : buf;
        if (text.length === 0 || text === lastShownText) return;
        lastShownText = text;
        try { await ctx.api.editMessageText(chatId, placeholderId, text); }
        catch (e) { log.warn('editMessageText failed', { err: e.message }); }
      }, telegramConfig.streamThrottleMs);
    }

    // Periodic progress update while codex is working (no streaming deltas in 0.125 exec mode).
    const progressTimer = setInterval(async () => {
      if (buf.length > 0) return; // once we have text, scheduleEdit takes over
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      const text = `⌛ думаю (${elapsedSec}с)\n${lastActivity}`;
      if (text === lastShownText) return;
      lastShownText = text;
      try { await ctx.api.editMessageText(chatId, placeholderId, text); }
      catch (e) { log.warn('progress editMessageText failed', { err: e.message }); }
    }, PROGRESS_INTERVAL_MS);

    let newSessionId = null;
    let turnUsage = null;
    const result = await runCodex({
      binary: codexConfig.binary,
      workspaceDir: codexConfig.workspaceDir,
      sandbox: codexConfig.sandbox,
      approval: codexConfig.approval,
      sessionId,
      prompt,
      images,
      timeoutMs: codexConfig.execTimeoutMs,
      reasoningEffort,
      ephemeral,
      onSpawn: (child) => { runningChildren.set(sessionKey, child); },
      onEvent: (ev) => {
        const sid = extractSessionId(ev);
        if (sid) newSessionId = sid;
        const activity = extractActivity(ev);
        if (activity) lastActivity = activity;
        const delta = extractTextDelta(ev);
        if (delta) { buf += delta; scheduleEdit(); }
        const u = extractUsage(ev);
        if (u) turnUsage = u;
      }
    });
    runningChildren.delete(sessionKey);
    const aborted = abortFlags.get(sessionKey) === true;
    if (aborted) abortFlags.delete(sessionKey);

    clearInterval(progressTimer);
    if (editPending) { clearTimeout(editPending); editPending = null; }
    const { emoji, cleaned } = extractReaction(buf);

    let parts;
    if (aborted) {
      parts = ['⛔ остановлено пользователем (/stop)' + (cleaned ? '\n\nЧастичный ответ:\n' + cleaned : '')];
    } else if (cleaned.length === 0) {
      parts = [result.exitCode === 0
        ? '(пустой ответ)'
        : `⚠️ codex exit ${result.exitCode}\n${result.stderr.slice(0, 500)}`];
    } else {
      parts = splitReply(cleaned);
    }

    // First part replaces the placeholder; subsequent parts go as new messages.
    try { await ctx.api.editMessageText(chatId, placeholderId, parts[0]); }
    catch (e) { log.warn('final editMessageText failed', { err: e.message }); }
    for (let i = 1; i < parts.length; i++) {
      try { await ctx.api.sendMessage(chatId, parts[i]); }
      catch (e) { log.warn('sendMessage (part) failed', { err: e.message, partIdx: i }); }
    }

    // Ephemeral runs (/btw) intentionally do not update the persisted session id —
    // the side question stays out of the conversation history.
    if (newSessionId && !ephemeral) sessions.set(sessionKey, newSessionId);

    // Usage counters apply to both real and ephemeral turns (real tokens were spent).
    if (turnUsage) accumulateUsage(sessionKey, turnUsage);

    if (emoji) await reactSafe(ctx, emoji);

    if (!aborted && result.exitCode !== 0) {
      lastError = `${new Date().toISOString()} codex exit ${result.exitCode}: ${result.stderr.slice(0, 300)}`;
      log.error('codex exited non-zero', { exitCode: result.exitCode, stderr: result.stderr.slice(0, 1000), bot: botConfig.name, chatId });
    }
  }

  bot.catch((err) => {
    lastError = `${new Date().toISOString()} ${err.error?.message || err.message}`;
    log.error('grammy uncaught', { err: err.error?.message || err.message, bot: botConfig.name });
  });

  // Publish the slash-command menu to Telegram so typing `/` shows autocomplete.
  // Fire-and-forget — failure shouldn't block the bot from polling.
  bot.api.setMyCommands(BOT_MENU_COMMANDS).then(
    () => log.info('bot menu published', { bot: botConfig.name, count: BOT_MENU_COMMANDS.length }),
    (e) => log.warn('setMyCommands failed', { bot: botConfig.name, err: e.message })
  );

  return bot;
}
