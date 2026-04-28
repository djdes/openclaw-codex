import { spawn } from 'node:child_process';

export function parseEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); }
  catch { return null; }
}

export function extractTextDelta(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type !== 'agent_message_delta' && ev.type !== 'text_delta' && ev.type !== 'message_delta') return null;
  if (typeof ev.delta === 'string') return ev.delta;
  if (ev.item && typeof ev.item.text === 'string') return ev.item.text;
  return null;
}

export function extractSessionId(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.session_id) return ev.session_id;
  if (ev.sessionId) return ev.sessionId;
  return null;
}

export function extractTaskComplete(ev) {
  return ev?.type === 'task_complete' || ev?.type === 'turn_complete';
}

/**
 * Spawn `codex exec` (or `codex exec resume`) and yield NDJSON events.
 * Callers consume events from `onEvent`; resolve `done` when the process exits.
 *
 * Windows note: npm global installs provide `codex.cmd` (not `codex.exe`).
 * Node spawn without shell:true cannot resolve .cmd extensions on Windows.
 * To avoid shell-injection risk from user prompt (passed as a positional arg),
 * we do NOT use shell:true. Instead we auto-suffix `.cmd` on Windows when the
 * bare binary name `codex` is passed — resolves correctly via PATH.
 *
 * @param {object} opts
 * @param {string} opts.binary - 'codex'
 * @param {string} opts.workspaceDir - --cd value
 * @param {string} opts.sandbox - 'workspace-write'
 * @param {string} opts.approval - 'never'
 * @param {string|null} opts.sessionId - resume id, or null for fresh
 * @param {string} opts.prompt - user message
 * @param {number} opts.timeoutMs
 * @param {(ev:object)=>void} opts.onEvent
 * @returns {Promise<{exitCode:number, signal:string|null, stderr:string}>}
 */
export function runCodex(opts) {
  // On Windows, npm global bin exposes codex.cmd, not codex.exe.
  // Using shell:true would allow shell-injection from opts.prompt, so we
  // instead resolve the .cmd extension explicitly on Windows.
  const isWin = process.platform === 'win32';
  const binary = isWin && opts.binary === 'codex' ? 'codex.cmd' : opts.binary;

  const args = ['exec'];
  if (opts.sessionId) args.push('resume', '--session-id', opts.sessionId);
  args.push(
    '--json',
    '--cd', opts.workspaceDir,
    '--sandbox', opts.sandbox,
    '--ask-for-approval', opts.approval,
    '--', opts.prompt
  );

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stderr = '';
    let stdoutBuf = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const ev = parseEventLine(line);
        if (ev) {
          try { opts.onEvent(ev); } catch { /* swallow handler errors */ }
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      // flush any remaining buffer
      if (stdoutBuf.trim()) {
        const ev = parseEventLine(stdoutBuf);
        if (ev) { try { opts.onEvent(ev); } catch {} }
      }
      resolve({ exitCode: killed ? -1 : exitCode, signal, stderr });
    });
  });
}
