// Renames a Claude Code session the way its own /rename does: a custom-title line appended to the
// transcript. The newest custom-title wins over the AI title, in Claude Code and in this app.

import { appendFile, open } from 'node:fs/promises'

export const MAX_TITLE_CHARS = 200

/** The title as it will be stored: one line, trimmed, clipped. Empty means "no rename". */
export function cleanTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS)
}

/** Appends a custom-title line. Returns false when there is nothing to write. */
export async function appendCustomTitle(filePath: string, sessionId: string, title: string): Promise<boolean> {
  const clean = cleanTitle(title)
  if (!clean) return false
  const line = JSON.stringify({ type: 'custom-title', customTitle: clean, sessionId }) + '\n'
  await appendFile(filePath, (await endsWithNewline(filePath)) ? line : '\n' + line, 'utf8')
  return true
}

// A transcript cut off mid-line (e.g. Claude Code killed while writing) would swallow our line.
async function endsWithNewline(filePath: string): Promise<boolean> {
  const fh = await open(filePath, 'r')
  try {
    const { size } = await fh.stat()
    if (size === 0) return true
    const buf = Buffer.alloc(1)
    await fh.read(buf, 0, 1, size - 1)
    return buf[0] === 0x0a
  } finally {
    await fh.close()
  }
}
