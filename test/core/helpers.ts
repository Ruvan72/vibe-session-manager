// Builders for synthetic transcript lines, shaped like real Claude Code 2.1.28x transcripts.

import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const tmpDir = (prefix = 'vsm-test-') => mkdtempSync(path.join(os.tmpdir(), prefix))

let n = 0
const base = (ts: string, extra: object = {}) => ({
  parentUuid: null,
  isSidechain: false,
  uuid: `u${++n}`,
  timestamp: ts,
  userType: 'external',
  entrypoint: 'claude-vscode',
  cwd: 'c:\\dev\\repo',
  sessionId: 'sess-1',
  version: '2.1.286',
  gitBranch: 'main',
  ...extra
})

export const L = {
  env: (ts: string, dir = 'c:\\dev\\repo', isWorktree = false) =>
    base(ts, { type: 'attachment', attachment: { type: 'environment', snapshot: { workingDirectory: dir, isWorktree, isGitRepo: true } } }),
  prompt: (ts: string, text: string, extra: object = {}) =>
    base(ts, { type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text }] }, ...extra }),
  reply: (ts: string, text: string, extra: object = {}) =>
    base(ts, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra }),
  toolUse: (ts: string, id: string, name = 'Bash') =>
    base(ts, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } }),
  toolResult: (ts: string, id: string) =>
    base(ts, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
  aiTitle: (title: string) => ({ type: 'ai-title', aiTitle: title, sessionId: 'sess-1' }),
  customTitle: (title: string) => ({ type: 'custom-title', customTitle: title, sessionId: 'sess-1' }),
  lastPrompt: (text: string) => ({ type: 'last-prompt', lastPrompt: text, sessionId: 'sess-1' }),
  relocated: (dir: string) => ({ type: 'relocated', sessionId: 'sess-1', relocatedCwd: dir }),
  worktreeState: (name: string) => ({ type: 'worktree-state', worktreeSession: { worktreeName: name }, sessionId: 'sess-1' })
}

export const jsonl = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
