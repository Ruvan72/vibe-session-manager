// Opt-in archive of every conversation (spec 3.9), one folder per session in <dir>/sessions/<id>/:
//
//   conversation.md   the prompts, replies and pasted text, readable without this app
//   raw/              gzipped copies of the session's own files, so a deleted transcript can be put back
//   meta.json         where each copy came from and how far it has been read
//
// The source files only grow, so each pass appends what is new: another gzip member to the raw copy
// and more text to conversation.md. The archive never deletes anything, and stays when the source goes.

import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { appendFile, mkdir, open, readdir, readFile, rename, stat, truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGunzip, gzip } from 'node:zlib'
import type { ArchiveDoc, ArchiveHit, ArchiveOpenState, ArchiveSessionInfo } from '../shared/types.ts'
import { cleanCodexPrompt, textOf } from './codex.ts'
import { writeJson } from './persist.ts'
import { pathKey } from './repo.ts'
import { SearchIndex, tokenize, type SearchDoc } from './search.ts'
import { toLocalIso } from './timelog.ts'
import { cleanPrompt, messageText, PASTED_RE } from './transcript.ts'

const gzipAsync = promisify(gzip)
const execFileAsync = promisify(execFile)

const CHUNK = 1 << 20
const NEWLINE = 0x0a
/** Ends the header of conversation.md; the header is rewritten when the title changes. */
const BODY_MARKER = '<!-- conversation -->'
const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex', cowork: 'Cowork' } as const

/** What rendering needs to remember between lines, also across restarts. */
export interface RenderState {
  /** The role of the last turn; a turn by the same role goes on without a new heading. */
  lastRole: string | null
  /** Codex: the current turn has a reply, so the copy of it in task_complete is skipped. */
  turnHasReply: boolean
  /** Codex versions can log a message twice. */
  lastText: string | null
}

export const newRenderState = (): RenderState => ({ lastRole: null, turnHasReply: false, lastText: null })

function when(v: unknown): string {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? '' : ` · ${toLocalIso(t).slice(0, 16).replace('T', ' ')}`
}

/** Closes a code fence left open, so it does not swallow the rest of the conversation. */
export function closeFences(text: string): string {
  let open: string | null = null
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!m) continue
    if (!open) open = m[1]
    else if (m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = null
  }
  return open ? `${text}\n${open}` : text
}

function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}\n${text}\n${fence}`
}

function turn(st: RenderState, role: string, stamp: unknown, text: string): string {
  const head = st.lastRole === role ? '' : `## ${role}${when(stamp)}\n\n`
  st.lastRole = role
  return `${head}${closeFences(text)}\n\n`
}

/** The Markdown for one line of a Claude Code or Cowork transcript, '' when it holds no conversation text. */
export function renderClaudeLine(o: any, st: RenderState, subagent = false): string {
  const content = o.message?.content
  const side = subagent || !!o.isSidechain
  if (o.type === 'assistant') {
    const text = Array.isArray(content) ? messageText(content).trim() : ''
    return text ? turn(st, side ? 'Subagent' : 'Claude', o.timestamp, text) : ''
  }
  if (o.type !== 'user') return ''
  if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) return ''
  // A subagent's task is often marked as meta. In the main conversation, meta is what the agent was told, not the user.
  if ((o.isMeta && !side) || o.isCompactSummary || o.isVisibleInTranscriptOnly) return ''
  if (!side && o.origin?.kind !== undefined && o.origin.kind !== 'human') return ''
  const parts: string[] = []
  const prompt = cleanPrompt(content)
  if (prompt) parts.push(prompt)
  for (const m of messageText(content).matchAll(PASTED_RE)) {
    const pasted = m[1].trim()
    if (pasted) parts.push(`**Pasted text**\n\n${fenced(pasted)}`)
  }
  if (Array.isArray(content)) {
    for (const b of content) if (b?.type === 'image' || b?.type === 'document') parts.push(`*[${b.type} attached]*`)
  }
  return parts.length ? turn(st, side ? 'Task for subagent' : 'You', o.timestamp, parts.join('\n\n')) : ''
}

/** The Markdown for one line of a Codex rollout, '' when it holds no conversation text. */
export function renderCodexLine(o: any, st: RenderState): string {
  const p = o.payload
  if (o.type !== 'event_msg' || !p || typeof p !== 'object') return ''
  const say = (role: 'You' | 'Codex', raw: string): string => {
    const text = role === 'You' ? cleanCodexPrompt(raw) : raw.trim()
    if (!text || text === st.lastText) return ''
    st.lastText = text
    if (role === 'Codex') st.turnHasReply = true
    return turn(st, role, o.timestamp, text)
  }
  switch (p.type) {
    case 'task_started':
      st.turnHasReply = false
      return ''
    case 'task_complete':
      return !st.turnHasReply && typeof p.last_agent_message === 'string' ? say('Codex', p.last_agent_message) : ''
    case 'item_completed':
      if (p.item?.type === 'UserMessage') return say('You', textOf(p.item.content))
      if (p.item?.type === 'AgentMessage') return say('Codex', textOf(p.item.content))
      return ''
    case 'user_message':
      return typeof p.message === 'string' ? say('You', p.message) : ''
    case 'agent_message':
      return typeof p.message === 'string' ? say('Codex', p.message) : ''
    default:
      return ''
  }
}

export function renderHeader(i: ArchiveSessionInfo): string {
  const facts = [
    ['Agent', AGENT_NAME[i.agent]],
    ['Repo', i.repo],
    ['Worktree', i.worktree],
    ['Branch', i.branch],
    ['Folder', i.homeDir],
    ['Started', toLocalIso(i.firstActivity).slice(0, 16).replace('T', ' ')],
    ['Session', i.id]
  ]
  const lines = facts.filter(([, v]) => v).map(([k, v]) => `- **${k}:** ${v}`)
  return `# ${i.title.replace(/\s+/g, ' ')}\n\n${lines.join('\n')}\n\n`
}

// ---------- restoring ----------

/** The Codex app and Cowork do not need the folder to open a session; Cowork does not need its transcript from here either. */
export function openNeeds(i: Pick<ArchiveSessionInfo, 'agent' | 'entrypoint'>): { folder: boolean; transcript: boolean } {
  if (i.agent === 'cowork') return { folder: false, transcript: false }
  const codexApp = i.agent === 'codex' && (i.entrypoint === 'codex_work_desktop' || i.entrypoint === 'Codex Desktop')
  return { folder: !codexApp, transcript: true }
}

export interface FolderPlan {
  kind: 'worktree' | 'empty'
  /** The branch to check out; null for a detached checkout of the repo's HEAD. */
  branch: string | null
}

/** How a missing folder comes back: as a git worktree while its repo exists, else as an empty folder. */
export function folderPlan(i: Pick<ArchiveSessionInfo, 'worktree' | 'repoPath' | 'homeDir' | 'branch'>, isRepo = (p: string) => existsSync(path.join(p, '.git'))): FolderPlan {
  const isWorktree = !!i.worktree && pathKey(i.repoPath) !== pathKey(i.homeDir) && isRepo(i.repoPath)
  // A branch name comes from a transcript; one that starts with "-" would be read as an option.
  const branch = i.branch && i.branch !== 'HEAD' && !i.branch.startsWith('-') ? i.branch : null
  return { kind: isWorktree ? 'worktree' : 'empty', branch }
}

/** Brings a missing folder back. Returns a note when the result differs from what the session had. */
export async function recreateFolder(i: ArchiveSessionInfo): Promise<string | null> {
  const plan = folderPlan(i)
  if (plan.kind === 'empty') {
    await mkdir(i.homeDir, { recursive: true })
    return `Created an empty folder: ${i.homeDir}`
  }
  const git = async (...args: string[]) => {
    try {
      await execFileAsync('git', args, { cwd: i.repoPath, windowsHide: true, timeout: 120_000 })
    } catch (e: any) {
      // Git writes progress to stderr too; the reason is the line that says so.
      const lines = String(e?.stderr || e?.message || e).trim().split(/\r?\n/)
      throw new Error(lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[lines.length - 1])
    }
  }
  // Git refuses a path it still has registered as a worktree whose folder is gone.
  await git('worktree', 'prune')
  if (!plan.branch) {
    await git('worktree', 'add', '--detach', '--', i.homeDir)
    return 'The session had no branch, so the worktree is on the current commit of the repo.'
  }
  const hasBranch = await git('rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`).then(
    () => true,
    () => false
  )
  if (!hasBranch) {
    await git('worktree', 'add', '-b', plan.branch, '--', i.homeDir)
    return `Branch ${plan.branch} no longer existed, so it was created again from the current commit of the repo.`
  }
  try {
    await git('worktree', 'add', '--', i.homeDir, plan.branch)
    return null
  } catch (e: any) {
    if (!/already (checked out|used)/i.test(e.message)) throw e
    await git('worktree', 'add', '--detach', '--', i.homeDir, plan.branch)
    return `Branch ${plan.branch} is checked out elsewhere, so the worktree has its commit detached.`
  }
}

// ---------- the archive ----------

interface ArchivedFile {
  /** Where the file is, or was. */
  source: string
  /** Part of the session's own transcript, as opposed to a subagent or a saved tool result. */
  main: boolean
  /** How far the source has been read. */
  offset: number
  /** The length of the copy this entry stands for; anything after it is left from an interrupted write. */
  rawBytes: number
  /** For files that are copied whole. */
  size?: number
  mtimeMs?: number
}

interface ArchiveMeta {
  info: ArchiveSessionInfo
  files: Record<string, ArchivedFile>
  render: RenderState
  header: string
  mdBytes: number
}

export interface ArchiveItem {
  info: ArchiveSessionInfo
  /** The session's transcript files, in order. */
  files: string[]
}

export interface SyncOptions {
  /** Checked between pieces of work; a pass that stops goes on from there the next time. */
  stop?(): boolean
  onProgress?(done: number, total: number): void
}

const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r))

async function isDir(p: string): Promise<boolean> {
  return !!(await stat(p).catch(() => null))?.isDirectory()
}

async function trimTo(file: string, bytes: number): Promise<void> {
  const st = await stat(file).catch(() => null)
  if (st && st.size > bytes) await truncate(file, bytes)
}

/** A session's other files: <transcript folder>/<id>/subagents and tool-results. Cowork keeps them the same way. */
async function extraFiles(mainFile: string, id: string): Promise<{ key: string; source: string }[]> {
  const dir = path.join(path.dirname(mainFile), id)
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])
  return entries
    .filter((e) => e.isFile())
    .map((e) => {
      const source = path.join(e.parentPath, e.name)
      return { key: path.join('extra', path.relative(dir, source)), source }
    })
}

export class ConversationArchive {
  readonly dir: string
  /** Changes when archived content changes. */
  version = 0
  private metas = new Map<string, ArchiveMeta>()
  private loading: Promise<void> | null = null
  private index = new SearchIndex()
  private indexing: Promise<void> | null = null

  constructor(dir: string) {
    this.dir = dir
  }

  private folderOf(id: string): string {
    return path.join(this.dir, 'sessions', id)
  }

  private rawFile(id: string, key: string): string {
    return path.join(this.folderOf(id), 'raw', `${key}.gz`)
  }

  private mdFile(id: string): string {
    return path.join(this.folderOf(id), 'conversation.md')
  }

  /** Reads what is archived already. Quick: only the meta files. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      const ids = await readdir(path.join(this.dir, 'sessions')).catch(() => [] as string[])
      await Promise.all(
        ids.map(async (id) => {
          try {
            const meta = JSON.parse(await readFile(path.join(this.folderOf(id), 'meta.json'), 'utf8'))
            if (meta?.info?.id === id && meta.files) this.metas.set(id, meta)
          } catch {
            // Not a finished session folder; the next pass starts it over if the session still exists.
          }
        })
      )
    })()
    return this.loading
  }

  get sessionCount(): number {
    return this.metas.size
  }

  get bytes(): number {
    let sum = 0
    for (const m of this.metas.values()) {
      sum += m.mdBytes
      for (const f of Object.values(m.files)) sum += f.rawBytes
    }
    return sum
  }

  /** Copies what is new, newest sessions first. A session that fails is tried again on the next pass. */
  async sync(items: ArchiveItem[], opts: SyncOptions = {}): Promise<string | null> {
    await this.load()
    const sorted = [...items].sort((a, b) => b.info.lastActivity - a.info.lastActivity)
    let error: string | null = null
    let done = 0
    for (const item of sorted) {
      if (opts.stop?.()) break
      try {
        if (await this.syncSession(item, opts)) {
          this.version++
          await this.reindex(item.info.id)
        }
      } catch (e: any) {
        error = `${item.info.title}: ${e?.message ?? e}`
      }
      opts.onProgress?.(++done, sorted.length)
      await yieldToEventLoop()
    }
    return error
  }

  private async syncSession(item: ArchiveItem, opts: SyncOptions): Promise<boolean> {
    const { id, homeDir } = item.info
    const known = this.metas.get(id)
    // Once the folder is gone it can no longer be told which repo a linked worktree belonged to.
    const info = known && !(await isDir(homeDir)) ? { ...item.info, worktree: item.info.worktree ?? known.info.worktree, repoPath: known.info.repoPath } : item.info
    const meta: ArchiveMeta = known ?? { info, files: {}, render: newRenderState(), header: '', mdBytes: 0 }
    let changed = !known || JSON.stringify(known.info) !== JSON.stringify(info)
    meta.info = info

    await mkdir(path.join(this.folderOf(id), 'raw'), { recursive: true })
    const header = renderHeader(info)
    if (meta.header !== header) {
      await this.writeHeader(id, meta, header)
      // The header's length is part of mdBytes, which repairs interrupted writes, so this is saved at once.
      writeJson(path.join(this.folderOf(id), 'meta.json'), meta)
      changed = true
    }
    try {
      const main = item.files.map((f) => ({ key: path.basename(f), source: f, main: true }))
      const extras = item.files[0] ? (await extraFiles(item.files[0], id)).map((f) => ({ ...f, main: false })) : []
      for (const f of [...main, ...extras]) {
        if (opts.stop?.()) break
        const entry = (meta.files[f.key] ??= { source: f.source, main: f.main, offset: 0, rawBytes: 0 })
        entry.source = f.source
        if (await (f.key.endsWith('.jsonl') ? this.appendJsonl(id, meta, f.key, entry, opts) : this.copyWhole(id, f.key, entry))) changed = true
      }
    } finally {
      if (changed) {
        // Last, so an interrupted pass is repeated from what meta.json says, not skipped.
        this.metas.set(id, meta)
        writeJson(path.join(this.folderOf(id), 'meta.json'), meta)
      }
    }
    return changed
  }

  private async writeHeader(id: string, meta: ArchiveMeta, header: string): Promise<void> {
    const file = this.mdFile(id)
    await trimTo(file, meta.mdBytes)
    const old = await readFile(file, 'utf8').catch(() => '')
    const at = old.indexOf(BODY_MARKER)
    const text = header + (at >= 0 ? old.slice(at) : `${BODY_MARKER}\n\n`)
    await writeFile(file + '.tmp', text)
    await rename(file + '.tmp', file)
    meta.header = header
    meta.mdBytes = Buffer.byteLength(text)
  }

  /** Copies what the source has gained since the last pass, up to its last complete line. */
  private async appendJsonl(id: string, meta: ArchiveMeta, key: string, entry: ArchivedFile, opts: SyncOptions): Promise<boolean> {
    const st = await stat(entry.source).catch(() => null)
    if (!st || st.size === entry.offset) return false
    const raw = this.rawFile(id, key)
    await mkdir(path.dirname(raw), { recursive: true })
    await trimTo(raw, entry.rawBytes)
    await trimTo(this.mdFile(id), meta.mdBytes)
    let changed = false
    if (st.size < entry.offset) {
      // The file was replaced. Keep the old copy and start a new one; nothing is lost, at worst text comes twice.
      await rename(raw, raw.replace(/\.gz$/, `.${Date.now()}.gz`)).catch(() => {})
      entry.offset = 0
      entry.rawBytes = 0
      changed = true
    }
    const subagent = !entry.main && key.includes('subagents')
    const render = (o: any) => (meta.info.agent === 'codex' ? renderCodexLine(o, meta.render) : renderClaudeLine(o, meta.render, subagent))

    const fh = await open(entry.source, 'r')
    try {
      let size = CHUNK
      let buf = Buffer.allocUnsafe(size)
      while (entry.offset < st.size && !opts.stop?.()) {
        const left = st.size - entry.offset
        const { bytesRead } = await fh.read(buf, 0, Math.min(size, left), entry.offset)
        if (bytesRead === 0) break
        const end = buf.subarray(0, bytesRead).lastIndexOf(NEWLINE)
        if (end < 0) {
          // A line longer than the buffer, or a last line still being written.
          if (bytesRead >= left) break
          size *= 2
          buf = Buffer.allocUnsafe(size)
          continue
        }
        const data = buf.subarray(0, end + 1)
        let md = ''
        for (const line of data.toString('utf8').split('\n')) {
          if (!line.trim()) continue
          try {
            md += render(JSON.parse(line))
          } catch {
            // Not valid JSON: it stays in the raw copy.
          }
        }
        const gz = await gzipAsync(data)
        await appendFile(raw, gz)
        entry.rawBytes += gz.length
        if (md) {
          await appendFile(this.mdFile(id), md)
          meta.mdBytes += Buffer.byteLength(md)
        }
        entry.offset += data.length
        changed = true
        await yieldToEventLoop()
      }
    } finally {
      await fh.close()
    }
    return changed
  }

  private async copyWhole(id: string, key: string, entry: ArchivedFile): Promise<boolean> {
    const st = await stat(entry.source).catch(() => null)
    if (!st || (st.size === entry.size && st.mtimeMs === entry.mtimeMs)) return false
    const raw = this.rawFile(id, key)
    await mkdir(path.dirname(raw), { recursive: true })
    const gz = await gzipAsync(await readFile(entry.source))
    await writeFile(raw + '.tmp', gz)
    await rename(raw + '.tmp', raw)
    entry.size = st.size
    entry.mtimeMs = st.mtimeMs
    entry.rawBytes = gz.length
    return true
  }

  private async body(id: string): Promise<string> {
    const md = await readFile(this.mdFile(id), 'utf8').catch(() => '')
    const at = md.indexOf(BODY_MARKER)
    return at >= 0 ? md.slice(at + BODY_MARKER.length).trim() : ''
  }

  private async searchDoc(meta: ArchiveMeta): Promise<SearchDoc> {
    const i = meta.info
    return { id: i.id, meta: [i.title, i.repo, i.worktree ?? '', i.branch ?? '', i.homeDir, i.id, i.agent], texts: [await this.body(i.id)] }
  }

  /** The conversation text is only held in memory once the archive is searched. */
  private ensureIndex(): Promise<void> {
    this.indexing ??= (async () => {
      await this.load()
      for (const meta of this.metas.values()) {
        this.index.set(await this.searchDoc(meta))
        await yieldToEventLoop()
      }
    })()
    return this.indexing
  }

  private async reindex(id: string): Promise<void> {
    const meta = this.metas.get(id)
    if (!this.indexing || !meta) return
    await this.indexing
    this.index.set(await this.searchDoc(meta))
  }

  /** All archived sessions that match, newest first. An empty query lists them all. */
  async search(query: string): Promise<ArchiveHit[]> {
    await this.ensureIndex()
    const found = tokenize(query).length ? this.index.search(query) : [...this.metas.keys()].map((id) => ({ id, snippet: null }))
    const hits = await Promise.all(
      found.map(async ({ id, snippet }) => {
        const meta = this.metas.get(id)
        return meta ? { ...meta.info, snippet, open: await this.openStateOf(meta) } : null
      })
    )
    return hits.filter((h) => h !== null).sort((a, b) => b.lastActivity - a.lastActivity)
  }

  async read(id: string): Promise<ArchiveDoc | null> {
    await this.load()
    const meta = this.metas.get(id)
    return meta ? { ...meta.info, markdown: await this.body(id), open: await this.openStateOf(meta) } : null
  }

  private async openStateOf(meta: ArchiveMeta): Promise<ArchiveOpenState> {
    const folderExists = await isDir(meta.info.homeDir)
    const main = Object.values(meta.files).filter((f) => f.main)
    const present = await Promise.all(main.map((f) => stat(f.source).then(() => true, () => false)))
    const transcriptExists = main.length > 0 && present.every(Boolean)
    const needs = openNeeds(meta.info)
    return { folderExists, transcriptExists, needsRestore: (needs.folder && !folderExists) || (needs.transcript && !transcriptExists) }
  }

  async infoOf(id: string): Promise<{ info: ArchiveSessionInfo; open: ArchiveOpenState; transcriptPath: string | null } | null> {
    await this.load()
    const meta = this.metas.get(id)
    if (!meta) return null
    const first = Object.values(meta.files).find((f) => f.main)
    return { info: meta.info, open: await this.openStateOf(meta), transcriptPath: first?.source ?? null }
  }

  conversationFile(id: string): string | null {
    return this.metas.has(id) ? this.mdFile(id) : null
  }

  /** Puts back the session's files that are gone. Files that still exist are left alone. */
  async restoreTranscript(id: string): Promise<void> {
    await this.load()
    const meta = this.metas.get(id)
    if (!meta) return
    for (const [key, f] of Object.entries(meta.files)) {
      if (existsSync(f.source) || !existsSync(this.rawFile(id, key))) continue
      await mkdir(path.dirname(f.source), { recursive: true })
      const tmp = `${f.source}.vsm-restore`
      await pipeline(createReadStream(this.rawFile(id, key)), createGunzip(), createWriteStream(tmp))
      await rename(tmp, f.source)
    }
  }
}
