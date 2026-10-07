// Creates a fake ~/.claude and ~/.codex with sessions in every state, for trying the UI without touching real data.
// Usage: npm run demo-data -- <dir>   then start the app with
//   VSM_CLAUDE_DIR=<dir>/.claude VSM_CODEX_DIR=<dir>/.codex VSM_DATA_DIR=<dir>/data VSM_ASSUME_ALIVE=1

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { HOOK_EVENTS } from '../src/core/hooks.ts'

const root = path.resolve(process.argv[2] ?? 'demo')
rmSync(root, { recursive: true, force: true })
const claude = path.join(root, '.claude')
const data = path.join(root, 'data')
mkdirSync(path.join(claude, 'sessions'), { recursive: true })
mkdirSync(data, { recursive: true })

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()
const events: object[] = []
let pid = 1000

interface Demo {
  id: string
  dir: string
  branch: string
  title: string
  prompts: [number, string][]
  reply?: [number, string]
  pendingTool?: [number, string]
  live?: 'busy' | 'idle'
  hook?: { event: string; minAgo: number; message?: string }[]
  worktree?: string
}

const demos: Demo[] = [
  {
    id: 'a1000000-0000-4000-8000-000000000001',
    dir: 'c:\\dev\\shop',
    branch: 'main',
    title: 'Fix checkout rounding error',
    prompts: [[30, 'The checkout total is off by one øre when VAT is applied to discounted items. Find and fix it.']],
    pendingTool: [3, 'Bash'],
    live: 'idle',
    hook: [{ event: 'Notification', minAgo: 2.9, message: 'Claude needs your permission to use Bash' }]
  },
  {
    id: 'a1000000-0000-4000-8000-000000000002',
    dir: 'c:\\dev\\shop\\.claude\\worktrees\\invoice-pdf',
    worktree: 'invoice-pdf',
    branch: 'worktree-invoice-pdf',
    title: 'Invoice PDF layout',
    prompts: [[50, 'Make the invoice PDF match the new brand template']],
    reply: [8, 'The PDF now uses the new template. All 14 invoice tests pass.'],
    live: 'idle',
    hook: [{ event: 'Stop', minAgo: 8 }]
  },
  {
    id: 'a1000000-0000-4000-8000-000000000003',
    dir: 'c:\\dev\\shop\\.claude\\worktrees\\search-index',
    worktree: 'search-index',
    branch: 'feat/search-index',
    title: 'Product search index migration',
    prompts: [[20, 'Migrate the product search to the new index and backfill']],
    live: 'busy',
    hook: [{ event: 'UserPromptSubmit', minAgo: 20 }]
  },
  {
    id: 'a1000000-0000-4000-8000-000000000004',
    dir: 'c:\\dev\\infra',
    branch: 'main',
    title: 'Backup rotation policy',
    prompts: [[90, 'Should we keep 14 or 30 days of nightly backups?']],
    reply: [70, 'Do you want me to apply the 30-day policy to production too?'],
    live: 'idle'
  },
  {
    id: 'a1000000-0000-4000-8000-000000000005',
    dir: 'c:\\dev\\infra',
    branch: 'renovate/node-24',
    title: 'Node 24 upgrade',
    prompts: [[300, 'Upgrade all services to Node 24']],
    reply: [240, 'Done. All services build on Node 24.']
  },
  {
    id: 'a1000000-0000-4000-8000-000000000006',
    dir: 'c:\\dev\\notes',
    branch: '',
    title: 'Meeting notes summary',
    prompts: [[60 * 30, 'Summarise the meeting notes from the planning session']],
    reply: [60 * 30 - 2, 'Here is the summary.']
  }
]

const line = (o: object) => JSON.stringify(o) + '\n'

for (const d of demos) {
  const proj = path.join(claude, 'projects', d.dir.replace(/[:\\/.]/g, '-'))
  mkdirSync(proj, { recursive: true })
  const base = { sessionId: d.id, cwd: d.dir, gitBranch: d.branch, entrypoint: 'claude-vscode', version: '2.1.286', isSidechain: false }
  let text = line({ ...base, type: 'attachment', timestamp: ago(d.prompts[0][0] + 0.1), attachment: { type: 'environment', snapshot: { workingDirectory: d.dir, isWorktree: !!d.worktree } } })
  for (const [m, p] of d.prompts) text += line({ ...base, type: 'user', timestamp: ago(m), origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: p }] } })
  if (d.reply) text += line({ ...base, type: 'assistant', timestamp: ago(d.reply[0]), message: { role: 'assistant', content: [{ type: 'text', text: d.reply[1] }] } })
  if (d.pendingTool) text += line({ ...base, type: 'assistant', timestamp: ago(d.pendingTool[0]), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + d.id.slice(-4), name: d.pendingTool[1], input: {} }] } })
  text += line({ type: 'ai-title', aiTitle: d.title, sessionId: d.id })
  if (d.worktree) text += line({ type: 'worktree-state', sessionId: d.id, worktreeSession: { worktreeName: d.worktree } })
  writeFileSync(path.join(proj, d.id + '.jsonl'), text)

  if (d.live) {
    pid++
    writeFileSync(path.join(claude, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: d.id, cwd: d.dir, kind: 'interactive', entrypoint: 'claude-vscode', status: d.live, statusUpdatedAt: now - 60_000 }))
  }
  for (const h of d.hook ?? []) events.push({ sessionId: d.id, event: h.event, time: now - h.minAgo * 60_000, ...(h.message ? { message: h.message } : {}) })
}

// Codex threads: one working, one with a finished turn you have not seen.
const codex = path.join(root, '.codex')
const codexDay = path.join(codex, 'sessions', '2026', '10', '01')
mkdirSync(codexDay, { recursive: true })
mkdirSync(path.join(codex, 'thread-writer-locks'), { recursive: true })
const codexDemos = [
  { id: '01a0f6be-0000-7000-8000-000000000001', dir: 'c:\\dev\\shop', branch: 'main', title: 'Debug PDF download 403', prompt: [12, 'The PDF download from the registry API returns 403. Why?'], reply: [4, 'The 403 comes from Cloudflare in front of the API: you get a browser challenge, not the PDF.'] as [number, string] },
  { id: '01a0f6be-0000-7000-8000-000000000002', dir: 'c:\\dev\\infra', branch: 'main', title: 'Terraform plan for staging', prompt: [6, 'Run terraform plan for staging and explain the diff'], reply: null }
]
const index: object[] = []
for (const c of codexDemos) {
  const ev = (min: number, payload: object) => line({ timestamp: ago(min), type: 'event_msg', payload })
  let text = line({ timestamp: ago(c.prompt[0] as number), type: 'session_meta', payload: { id: c.id, cwd: c.dir, originator: 'codex_work_desktop', cli_version: '0.155.0', source: 'vscode', thread_source: 'user', git: { branch: c.branch } } })
  text += ev(c.prompt[0] as number, { type: 'task_started', turn_id: 't1' })
  text += ev(c.prompt[0] as number, { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: c.prompt[1] }] } })
  if (c.reply) {
    text += ev(c.reply[0], { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: c.reply[1] }], phase: 'final_answer' } })
    text += ev(c.reply[0], { type: 'task_complete', turn_id: 't1' })
  } else text += ev(0.2, { type: 'item_completed', item: { type: 'CommandExecution' } })
  writeFileSync(path.join(codexDay, `rollout-2026-10-01T10-00-00-${c.id}.jsonl`), text)
  writeFileSync(path.join(codex, 'thread-writer-locks', `${c.id}.lock`), '')
  index.push({ id: c.id, thread_name: c.title, updated_at: ago(0) })
}
writeFileSync(path.join(codex, 'session_index.jsonl'), index.map((e) => JSON.stringify(e)).join('\n') + '\n')

const command = `node "${path.join(data, 'hook.cjs').replace(/\\/g, '/')}" # vibe-session-manager`
writeFileSync(
  path.join(claude, 'settings.json'),
  JSON.stringify({ hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: 'command', command }] }]])) }, null, 2)
)
writeFileSync(path.join(data, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
// Everything older than two hours counts as seen.
writeFileSync(path.join(data, 'state.json'), JSON.stringify({ initializedAt: now - 2 * 3600_000, seen: {} }))
console.log(`Demo data in ${root}`)
