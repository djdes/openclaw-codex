import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

export const ATTACH_TMP_DIR = join(tmpdir(), 'openclaw-codex-attachments');
export const ATTACH_CLEANUP_MS = 30 * 60 * 1000; // 30 min

export async function downloadAttachment(ctx, fileId, { botToken, hint }) {
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download HTTP ${response.status}`);
  const buf = Buffer.from(await response.arrayBuffer());
  mkdirSync(ATTACH_TMP_DIR, { recursive: true });
  const ext = extname(file.file_path) || extname(hint || '') || '.bin';
  const safeHint = (hint || '').replace(/[^\w.\-]/g, '_').slice(0, 60);
  const fname = `${Date.now()}-${fileId.slice(-8)}${safeHint ? '_' + safeHint : ''}${ext}`;
  const path = join(ATTACH_TMP_DIR, fname);
  writeFileSync(path, buf);
  return { path, sizeBytes: buf.length, mime: file.file_path };
}

export function scheduleCleanup(path) {
  setTimeout(() => { try { unlinkSync(path); } catch {} }, ATTACH_CLEANUP_MS);
}

export async function reactSafe(ctx, emoji) {
  try {
    if (emoji === null || emoji === undefined) {
      await ctx.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, []);
    } else {
      await ctx.react(emoji);
    }
  } catch { /* ignore — reactions are best-effort */ }
}
