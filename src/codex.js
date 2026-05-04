import { spawn } from 'node:child_process';

export function parseEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); }
  catch { return null; }
}

export function extractTextDelta(ev) {
  if (!ev || typeof ev !== 'object') return null;
  // Codex 0.125: final reply lands as item.completed with item.type=agent_message
  if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
    return ev.item.text;
  }
  // Hypothetical future streaming variants (kept for forward compatibility)
  if (ev.type === 'agent_message_delta' || ev.type === 'text_delta' || ev.type === 'message_delta') {
    if (typeof ev.delta === 'string') return ev.delta;
    if (ev.item && typeof ev.item.text === 'string') return ev.item.text;
  }
  return null;
}

export function extractSessionId(ev) {
  if (!ev || typeof ev !== 'object') return null;
  // Codex 0.125: session id arrives as thread.started/thread_id
  if (ev.type === 'thread.started' && ev.thread_id) return ev.thread_id;
  // Older naming, kept defensive
  if (ev.session_id) return ev.session_id;
  if (ev.sessionId) return ev.sessionId;
  if (ev.thread_id) return ev.thread_id;
  return null;
}

export function extractTaskComplete(ev) {
  return ev?.type === 'turn.completed' || ev?.type === 'task_complete' || ev?.type === 'turn_complete';
}

/**
 * Returns a short human-readable label for the current Codex activity, or null
 * if the event isn't a useful progress signal. Used to keep the user informed
 * during long turns where Codex 0.125 doesn't stream message deltas.
 */
export function extractActivity(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'item.started' && ev.item) {
    const it = ev.item;
    if (it.type === 'command_execution' && typeof it.command === 'string') {
      const cmd = it.command.replace(/\s+/g, ' ').trim();
      return `🔧 ${cmd.length > 80 ? cmd.slice(0, 77) + '…' : cmd}`;
    }
    if (it.type === 'reasoning' || it.type === 'thinking') return '🤔 размышляю';
    if (it.type === 'web_search') return '🌐 веб-поиск';
    if (it.type === 'file_search') return '🔍 поиск по файлам';
    if (it.type === 'agent_message') return '✍️ пишу ответ';
    if (typeof it.type === 'string') return `▶ ${it.type}`;
  }
  if (ev.type === 'turn.started') return '⏳ старт хода';
  return null;
}

/**
 * Spawn `codex exec` (or `codex exec resume`) and yield NDJSON events.
 * The user's prompt is piped via stdin (codex's `-` argument) rather than
 * passed as a positional argument. This is required because:
 *   1) On Windows (Node 18.20+/CVE-2024-27980), `spawn('codex.cmd', ...)` without
 *      `shell:true` fails with EINVAL.
 *   2) With `shell:true`, passing user input as an arg would risk shell injection.
 * Piping prompt via stdin keeps `shell:true` safe — only config-controlled args
 * (workspaceDir, sandbox, approval, sessionId from codex itself) reach the shell.
 *
 * @param {object} opts
 * @param {string} opts.binary - 'codex'
 * @param {string} opts.workspaceDir - --cd value
 * @param {string} opts.sandbox - 'workspace-write'
 * @param {string} opts.approval - 'never'
 * @param {string|null} opts.sessionId - resume id, or null for fresh
 * @param {string} opts.prompt - user message (piped to stdin)
 * @param {number} opts.timeoutMs
 * @param {(ev:object)=>void} opts.onEvent
 * @returns {Promise<{exitCode:number, signal:string|null, stderr:string}>}
 */
export function runCodex(opts) {
  const isWin = process.platform === 'win32';
  const binary = isWin && opts.binary === 'codex' ? 'codex.cmd' : opts.binary;

  // Codex 0.125 exec mode: `--full-auto` is a convenience for sandboxed
  // automatic execution (workspace-write + no approval prompts). The older
  // `--ask-for-approval` flag does not exist on `exec`. We keep `opts.sandbox`
  // and `opts.approval` in the config schema for forward compatibility but
  // they are not currently passed to the CLI.
  // Codex 0.125 syntax differs between fresh exec and resume:
  //   fresh:  codex exec --json --cd <dir> --full-auto [-i <img>]... -
  //   resume: codex exec resume --json --full-auto [-i <img>]... <SESSION_ID> -
  // Resume does NOT accept --cd (inherits workspace from the original session).
  // Session id is positional after `resume` (after options).
  // Images: codex `-i, --image <FILE>` (repeatable on both fresh and resume).
  const imageArgs = [];
  if (opts.images?.length) {
    for (const img of opts.images) imageArgs.push('-i', img);
  }
  const args = ['exec'];
  if (opts.sessionId) {
    args.push('resume', '--json', '--full-auto', ...imageArgs, opts.sessionId, '-');
  } else {
    args.push('--json', '--cd', opts.workspaceDir, '--full-auto', ...imageArgs, '-');
  }

  // Codex 0.125 has a known bug where models_manager hangs after a successful
  // turn ("failed to refresh available models: timeout") — the process keeps
  // running for minutes even though the agent_message item already shipped.
  // Strategy: once we observe agent_message text OR turn.completed, give the
  // process POST_TASK_GRACE_MS to exit cleanly; if it doesn't, kill it but
  // resolve as success (we have the reply).
  const POST_TASK_GRACE_MS = 8000;

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, shell: isWin });
    let stderr = '';
    let stdoutBuf = '';
    let killed = false;
    let gotReplyText = false;
    let postTaskTimer = null;

    const hardTimer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    function armPostTaskGrace() {
      if (postTaskTimer) return;
      postTaskTimer = setTimeout(() => {
        // Codex hung after replying — kill it but don't mark as killed
        // (we have the agent_message text, treat as success).
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, POST_TASK_GRACE_MS);
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const ev = parseEventLine(line);
        if (ev) {
          if (extractTextDelta(ev) || extractTaskComplete(ev)) {
            if (!gotReplyText) { gotReplyText = true; armPostTaskGrace(); }
          }
          try { opts.onEvent(ev); } catch { /* swallow handler errors */ }
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      clearTimeout(hardTimer);
      if (postTaskTimer) clearTimeout(postTaskTimer);
      reject(err);
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(hardTimer);
      if (postTaskTimer) clearTimeout(postTaskTimer);
      if (stdoutBuf.trim()) {
        const ev = parseEventLine(stdoutBuf);
        if (ev) { try { opts.onEvent(ev); } catch {} }
      }
      // If we killed the process AFTER receiving reply text (post-task grace),
      // treat the exit as success — the reply is what matters.
      const effectiveExitCode = (killed && !gotReplyText) ? -1
                              : (gotReplyText && exitCode !== 0) ? 0
                              : exitCode;
      resolve({ exitCode: effectiveExitCode, signal, stderr });
    });

    child.stdin.setDefaultEncoding('utf8');
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}
