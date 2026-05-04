// Minimal OpenAI-style chat-completions HTTP shim, backed by `codex exec`.
//
// Replaces the legacy clawdbot HTTP gateway on the same port, so independent
// scripts (e.g. yesbeat_autoresponder_v2.mjs) keep working but generate
// replies via the user's ChatGPT subscription instead of paid Anthropic API.

import http from 'node:http';
import { runCodex, extractTextDelta, extractSessionId, extractTaskComplete } from './codex.js';

const SYSTEM_INSTRUCTION = `Ниже история переписки. Сгенерируй ОДИН короткий ответ (1-3 предложения, без преамбул, без объяснений своих действий, без markdown). Только текст самого ответа — он будет отправлен пользователю как есть.`;

/**
 * Build a single Codex prompt from an OpenAI-style messages array.
 * System messages and conversation history are concatenated into a structured
 * text block that Codex reads via stdin.
 */
export function messagesToPrompt(messages) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n').trim();
  const history = messages.filter(m => m.role !== 'system');

  const lines = [SYSTEM_INSTRUCTION];
  if (sys) {
    lines.push('');
    lines.push('# Системные инструкции');
    lines.push(sys);
  }
  lines.push('');
  lines.push('# История переписки');
  for (const m of history) {
    const tag = m.role === 'assistant' ? '[ты ответил]' : '[клиент]';
    lines.push(`${tag}: ${m.content}`);
  }
  lines.push('');
  lines.push('# Твой ответ (только текст, без обрамления):');
  return lines.join('\n');
}

/**
 * Run codex exec on the assembled prompt and return the agent's text reply.
 */
export async function generateChatReply({ messages, codexConfig, log }) {
  const prompt = messagesToPrompt(messages);
  let buf = '';
  const result = await runCodex({
    binary: codexConfig.binary,
    workspaceDir: codexConfig.workspaceDir,
    sandbox: codexConfig.sandbox,
    approval: codexConfig.approval,
    sessionId: null,                         // each request stateless; caller manages history
    prompt,
    timeoutMs: codexConfig.execTimeoutMs,
    onEvent: (ev) => {
      const delta = extractTextDelta(ev);
      if (delta) buf += delta;
      // ignore session_id and task_complete here — single-shot
    }
  });
  if (result.exitCode !== 0) {
    log?.error?.('chatCompletions: codex non-zero', { exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) });
    throw new Error(`codex exit ${result.exitCode}`);
  }
  return buf.trim();
}

/**
 * Format the OpenAI chat-completions response for a given assistant text.
 */
export function buildOpenAIResponse({ model, content, promptChars, completionChars }) {
  return {
    id: `chatcmpl-shim-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'codex-shim',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: Math.ceil((promptChars || 0) / 4),
      completion_tokens: Math.ceil((completionChars || 0) / 4),
      total_tokens: Math.ceil(((promptChars || 0) + (completionChars || 0)) / 4)
    }
  };
}

/**
 * Build the HTTP server. `bearerToken` is required for the auth header check.
 */
export function createShimServer({ bearerToken, codexConfig, log }) {
  if (!bearerToken) throw new Error('chatCompletionsShim.bearerToken is required');

  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'openclaw-codex-shim' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${bearerToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unauthorized', type: 'invalid_request_error' } }));
        return;
      }

      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        let parsed;
        try { parsed = JSON.parse(body); }
        catch { res.writeHead(400); res.end('{"error":"invalid json"}'); return; }

        const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
        if (!messages || messages.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'messages required', type: 'invalid_request_error' } }));
          return;
        }

        try {
          const prompt = messagesToPrompt(messages);
          const reply = await generateChatReply({ messages, codexConfig, log });
          const responseBody = buildOpenAIResponse({
            model: parsed.model,
            content: reply || '(пустой ответ)',
            promptChars: prompt.length,
            completionChars: reply.length
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseBody));
          log?.info?.('chatCompletions: ok', { messages: messages.length, replyChars: reply.length });
        } catch (e) {
          log?.error?.('chatCompletions: failed', { err: e.message });
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message, type: 'shim_error' } }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });
}
