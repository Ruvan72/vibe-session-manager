// The Work tab: creates git worktrees under <repo>/.claude/worktrees, lets an agent commit what is in them,
// pushes, merges and removes them again, and tells where each one stands. Work in the repo's own folder is
// listed with them, to commit, push and merge, but that folder is never removed. Everything but the commit is
// plain git; the commit runs the chosen agent's CLI headless, limited to reading, staging and committing.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { LiveStatus, WorkAgent, WorkCreateOptions, WorkItem, WorkJournalEntry, WorkOverview, WorkPr, WorkRepo, WorkRun, WorkSetupInfo, WorkState } from '../shared/types.ts'
import { writeJson } from './persist.ts'
import { pathKey } from './repo.ts'

const execFileAsync = promisify(execFile)

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
/** The GitHub CLI must never stop to ask: there is no terminal to answer in. */
const GH_ENV = { ...GIT_ENV, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }

/** Where commands are written down as they are run, with what they printed. */
export interface CommandLog {
  /** A command that has ended. */
  command(cwd: string, line: string, output: string, exit: number, ms: number): void
}

/**
 * Runs git and returns its output. --no-optional-locks: reading status must not get in the way of an agent's
 * own git. With a log, the command and all it printed are written there, also when it fails.
 */
export function git(cwd: string, args: string[], timeout = 30_000, log?: CommandLog): Promise<string> {
  const argv = ['--no-optional-locks', ...args]
  const started = Date.now()
  return new Promise((resolve, reject) => {
    execFile('git', argv, { cwd, windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, env: GIT_ENV }, (err, stdout, stderr) => {
      log?.command(cwd, `git ${argv.join(' ')}`, stdout + stderr, err ? (typeof err.code === 'number' ? err.code : -1) : 0, Date.now() - started)
      if (!err) return resolve(stdout)
      const text = String(stderr || err.message || err).trim()
      reject(new Error(text.replace(/^(fatal|error): /, '') || 'git failed'))
    })
  })
}

async function tryGit(cwd: string, args: string[], timeout?: number, log?: CommandLog): Promise<string | null> {
  try {
    return await git(cwd, args, timeout, log)
  } catch {
    return null
  }
}

/** Runs a program that is not git and returns what it printed, or null when it fails. With a log, it is written there. */
function tryRun(cwd: string, bin: string, args: string[], timeout = 30_000, log?: CommandLog): Promise<string | null> {
  const started = Date.now()
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, env: GH_ENV }, (err, stdout, stderr) => {
      log?.command(cwd, [bin, ...args].join(' '), stdout + stderr, err ? (typeof err.code === 'number' ? err.code : -1) : 0, Date.now() - started)
      resolve(err ? null : stdout)
    })
  })
}

const LOG_MAX_BYTES = 5 * 1024 * 1024

/**
 * The exact commands the Work tab ran and everything they printed, appended to one text file as it happens.
 * Reading where the worktrees stand (git status and the like, every few seconds) is left out; all that
 * creates, commits, pushes, merges, fetches or removes is in.
 */
export class WorkLog implements CommandLog {
  readonly file: string
  private midLine = false

  constructor(file: string) {
    this.file = file
  }

  /** Raw text, as a running command prints it. */
  write(text: string): void {
    if (!text) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      appendFileSync(this.file, text)
      this.midLine = !text.endsWith('\n')
    } catch {}
  }

  private line(text: string): void {
    this.write(`${this.midLine ? '\n' : ''}${text}\n`)
  }

  /** A heading for what the user asked for; the commands under it belong to it. */
  action(title: string): void {
    // One older file is kept when this one gets big.
    try {
      if (statSync(this.file).size > LOG_MAX_BYTES) renameSync(this.file, this.file.replace(/\.log$/, '.1.log'))
    } catch {}
    this.line(`\n===== ${new Date().toISOString()}  ${title} =====`)
  }

  /** A command that starts now; what it prints follows through write(), then end(). */
  start(cwd: string, line: string): void {
    this.line(`[${new Date().toISOString()}] ${cwd}> ${line}`)
  }

  end(exit: number, ms: number): void {
    this.line(`[exit ${exit} · ${ms} ms]`)
  }

  note(text: string): void {
    this.line(`[${text}]`)
  }

  command(cwd: string, line: string, output: string, exit: number, ms: number): void {
    this.start(cwd, line)
    this.write(output)
    this.end(exit, ms)
  }

  /** The end of the log, for showing in the window. */
  tail(maxBytes = 200_000): { text: string; truncated: boolean } {
    try {
      const size = statSync(this.file).size
      const from = Math.max(0, size - maxBytes)
      const buf = Buffer.alloc(size - from)
      const fd = openSync(this.file, 'r')
      try {
        readSync(fd, buf, 0, buf.length, from)
      } finally {
        closeSync(fd)
      }
      const text = buf.toString('utf8')
      // Start at a whole line when the beginning is cut off.
      return { text: from ? text.slice(text.indexOf('\n') + 1) : text, truncated: from > 0 }
    } catch {
      return { text: '', truncated: false }
    }
  }
}

// ---------- reading git's output ----------

export interface WorktreeEntry {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  /** Git has the worktree on record, but its folder is gone. */
  prunable: boolean
  /** Locked with `git worktree lock`, as an agent does for the worktree it runs in. */
  locked: boolean
}

/** `git worktree list --porcelain`; the first entry is the repo's own checkout. */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    let entry: WorktreeEntry | null = null
    for (const line of block.split(/\r?\n/)) {
      const [word, rest = ''] = [line.split(' ', 1)[0], line.slice(line.indexOf(' ') + 1)]
      if (word === 'worktree') entry = { path: path.resolve(rest), head: null, branch: null, bare: false, prunable: false, locked: false }
      else if (!entry) continue
      else if (word === 'HEAD') entry.head = rest
      else if (word === 'branch') entry.branch = rest.replace(/^refs\/heads\//, '')
      else if (line === 'bare') entry.bare = true
      else if (word === 'prunable') entry.prunable = true
      else if (word === 'locked') entry.locked = true
    }
    if (entry) out.push(entry)
  }
  return out
}

export interface StatusInfo {
  branch: string | null
  upstream: string | null
  /** Commits not on the upstream; null without an upstream, or when the upstream branch is gone. */
  toPush: number | null
  changed: number
}

/** `git status --porcelain=v2 --branch`. */
export function parseStatus(text: string): StatusInfo {
  const s: StatusInfo = { branch: null, upstream: null, toPush: null, changed: 0 }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) s.branch = line.slice(14) === '(detached)' ? null : line.slice(14)
    else if (line.startsWith('# branch.upstream ')) s.upstream = line.slice(18)
    else if (line.startsWith('# branch.ab ')) s.toPush = Number(/\+(\d+)/.exec(line)?.[1] ?? 0)
    else if (line && !line.startsWith('#')) s.changed++
  }
  return s
}

export function workState(f: { exists: boolean; busy: boolean; changed: number; merged: boolean; everCommitted: boolean }): WorkState {
  if (!f.exists) return 'orphaned'
  if (f.busy) return 'working'
  if (f.changed > 0) return 'uncommitted'
  if (f.merged) return f.everCommitted ? 'ready' : 'new'
  return 'pending-merge'
}

/**
 * The state of the repo's own folder. It is not there to be merged and removed like a worktree, so it only
 * counts as work while something in it is left to commit, merge or push; 'ready' means there is nothing.
 */
export function rootState(f: { busy: boolean; changed: number; ahead: number; toPush: number | null }): WorkState {
  if (!f.changed && !f.ahead && !f.toPush) return 'ready'
  if (f.busy) return 'working'
  if (f.changed > 0) return 'uncommitted'
  return f.ahead > 0 ? 'pending-merge' : 'unpushed'
}

/**
 * What a branch was made from, as git's reflog has it: the name given to `git branch`, `switch -c` or
 * `worktree add`, or the branch that was checked out when it was made with `checkout -b`. Both logs are
 * `git reflog show --format=%H%x09%gs`, newest first. Null when it is not on record, which is so for a
 * branch made on another machine, or one whose reflog has expired.
 */
export function createdFrom(branchLog: string, headLog: string, branch: string): string | null {
  const [sha, subject] = (branchLog.split(/\r?\n/).filter(Boolean).pop() ?? '').split('\t')
  const from = /^branch: Created from (.+)$/.exec(subject ?? '')?.[1]
  if (!from) return null
  if (from !== 'HEAD') return from.replace(/^refs\/(heads|remotes)\//, '')
  // Made from what was checked out: the checkout that went to it at that same commit says from where.
  const start = 'checkout: moving from '
  const end = ` to ${branch}`
  const move = headLog.split(/\r?\n/).filter((l) => l.startsWith(`${sha}\t${start}`) && l.endsWith(end)).pop()
  const prev = move?.slice(sha.length + 1 + start.length, -end.length)
  return prev && !/^[0-9a-f]{40}$/.test(prev) ? prev : null
}

/** Why a name cannot be used for a worktree and its branch, or null when it can. The name is a folder and a git ref. */
export function worktreeNameError(name: string): string | null {
  if (!name) return 'Give the worktree a name.'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return 'Use letters, digits, dash, underscore and dot, starting with a letter or digit.'
  if (name.length > 80) return 'Use at most 80 characters.'
  if (name.includes('..') || name.endsWith('.') || name.endsWith('.lock')) return 'Git does not allow this name for a branch.'
  return null
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const RESULT_LINES = 40

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('')
  return ''
}

/**
 * The text to show for one line of `claude -p --output-format stream-json`: what the agent says, the
 * commands it runs and what they print. Other tools show as one line, and their result only when it is an
 * error. shellIds carries the ids of the shell commands from one line to the next; the command log has
 * the lines themselves.
 */
export function claudeStreamText(o: any, shellIds: Set<string> = new Set()): string {
  let out = ''
  if (o?.type === 'assistant' && Array.isArray(o.message?.content)) {
    for (const c of o.message.content) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) out += c.text.trim() + '\n\n'
      else if (c?.type === 'tool_use') {
        const shell = SHELL_TOOLS.has(c.name)
        if (shell && typeof c.id === 'string') shellIds.add(c.id)
        const target = c.input?.command ?? c.input?.file_path ?? c.input?.pattern
        out += shell ? `$ ${c.input?.command ?? ''}\n` : `[${c.name}${typeof target === 'string' ? ' ' + target : ''}]\n`
      }
    }
    return out
  }
  if (o?.type === 'user' && Array.isArray(o.message?.content)) {
    for (const c of o.message.content) {
      if (c?.type !== 'tool_result' || !(c.is_error || shellIds.has(c.tool_use_id))) continue
      const text = resultText(c.content).trim()
      if (!text || /^\((Bash|PowerShell) completed with no output\)$/.test(text)) continue
      const lines = text.split(/\r?\n/)
      out += lines.slice(0, RESULT_LINES).join('\n') + (lines.length > RESULT_LINES ? `\n… ${lines.length - RESULT_LINES} more lines, see the command log` : '') + '\n'
    }
    return out
  }
  // The final result repeats the last message; only an error says something new.
  if (o?.type === 'result' && o.is_error) return `${typeof o.result === 'string' && o.result ? o.result : `The agent stopped: ${o.subtype ?? 'error'}`}\n`
  return ''
}

// ---------- what a new worktree brings along ----------

const LOCKFILES: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun']
]

/** The install command for a folder with a package.json, by the lockfile next to it; null without a package.json. */
export function installCommand(dir: string): string | null {
  if (!existsSync(path.join(dir, 'package.json'))) return null
  return `${LOCKFILES.find(([file]) => existsSync(path.join(dir, file)))?.[1] ?? 'npm'} install`
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Takes away every link named node_modules in a worktree and returns their paths. This must happen before
 * git removes the worktree: git deletes through a junction, which would empty the node_modules it points
 * to. Real node_modules folders are not looked into.
 */
export function unlinkNodeModules(root: string): string[] {
  const removed: string[] = []
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isSymbolicLink()) {
        if (e.name !== 'node_modules') continue
        unlinkSync(p)
        removed.push(p)
      } else if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') walk(p)
    }
  }
  walk(root)
  return removed
}

// ---------- agents ----------

const AGENT_BIN: Record<WorkAgent, string> = { claude: 'claude', codex: 'codex' }
const AGENT_NAME: Record<WorkAgent, string> = { claude: 'Claude Code', codex: 'Codex' }

/**
 * What the agent is allowed for a commit on top of the user's own Claude Code settings: look, stage and
 * commit, in either shell (on Windows it has PowerShell next to Bash). Nothing here lets it push or edit.
 */
const GIT_ALLOWED = ['status', 'diff', 'log', 'show', 'add', 'commit']
const CLAUDE_ALLOWED = [...['Bash', 'PowerShell'].flatMap((shell) => GIT_ALLOWED.map((sub) => `${shell}(git ${sub}:*)`)), 'Read', 'Grep', 'Glob']

export const COMMIT_PROMPT = [
  'Commit the work in this git worktree.',
  'Look at `git status` and `git diff`, stage what belongs to the work, and commit it with a message in the style of the recent commits in `git log`.',
  'Leave out files that look like secrets, local settings or build output, and say which ones you left out.',
  'Run plain `git add` and `git commit -m` commands, one command at a time, without heredocs, pipes, `&&` or command substitution. For a message with a body, pass -m twice.',
  'Do not push, merge, amend, switch branch or change any file.',
  'End with a short summary: the commit you made, what is in it, and anything that is still uncommitted.'
].join('\n')

/** The shell command line that runs the agent headless; the prompt goes in on stdin. */
export function agentCommand(agent: WorkAgent, repoPath: string): string {
  if (agent === 'claude') return `claude -p --output-format stream-json --verbose --allowedTools ${CLAUDE_ALLOWED.map((t) => `"${t}"`).join(' ')}`
  // A linked worktree keeps its index in the main repo's .git, outside the folder Codex may write to.
  const gitDir = path.join(repoPath, '.git').replace(/\\/g, '/')
  const extra = /['"%]/.test(gitDir) ? '' : ` -c "sandbox_workspace_write.writable_roots=['${gitDir}']"`
  return `codex exec --full-auto${extra} -`
}

async function onPath(bin: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [bin], { windowsHide: true, timeout: 5000 })
    return true
  } catch {
    return false
  }
}

// ---------- the manager ----------

export interface WorkDeps {
  dataDir: string
  /** Main-repo folders of recent sessions, most recent first. */
  knownRepos(): string[]
  sessions(): { homeDir: string; status: LiveStatus }[]
  /** Which agent CLIs are installed; default looks on PATH. */
  detectAgents?(): Promise<WorkAgent[]>
  /** The command line for a commit; default runs the agent's CLI. */
  agentCommand?(agent: WorkAgent, repoPath: string): string
  /** Whether the GitHub CLI is installed; default looks on PATH. */
  detectGh?(): Promise<boolean>
  /** The program and arguments that run the GitHub CLI with these arguments; default is `gh` itself. */
  ghCommand?(args: string[]): string[]
}

interface WorkFile {
  agent: WorkAgent | null
  lastRepo: string | null
  /** Repos a worktree was created in, or that the user added. */
  repos: string[]
  /** "<repo key>|<branch>" → the branch it was created from. */
  bases: Record<string, string>
  /** The options a worktree was last created with. */
  setup: WorkCreateOptions
}

interface WorkEvents {
  run: [WorkRun | null]
  /** Something changed on disk; the overview should be read again. */
  changed: []
}

/** What stands in the way of removing a worktree. */
export interface CleanupPlan {
  item: WorkItem
  /** Set when it must not be removed at all. */
  blocked: string | null
  /** What would be lost; removing then needs the user's say-so. */
  losses: string[]
  notes: string[]
}

export interface MergePlan {
  item: WorkItem
  /** The branch to merge into. */
  into: string
  /** The checkout that has that branch, where the merge runs; null when no folder has it checked out. */
  target: string | null
}

export interface PrPlan {
  item: WorkItem
  /** The branch the pull request asks to merge into. */
  base: string
  remote: string
  /** The remote does not have the branch as it is here, so it is pushed first. */
  push: boolean
}

/** The last pull request link in what the GitHub CLI printed: the one it made, or the one that was there already. */
export function prInText(text: string): WorkPr | null {
  const all = [...text.matchAll(/https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/g)]
  const last = all[all.length - 1]
  return last ? { number: Number(last[1]), url: last[0] } : null
}

const MAX_RUN_TEXT = 400_000
const JOURNAL_SHOWN = 60

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function isRepoRoot(dir: string): boolean {
  try {
    return statSync(path.join(dir, '.git')).isDirectory()
  } catch {
    return false
  }
}

/** Whether merging head into base would leave base's files as they are. */
async function addsNothing(repoPath: string, base: string, head: string): Promise<boolean> {
  const [tree, baseTree] = await Promise.all([tryGit(repoPath, ['merge-tree', '--write-tree', base, head]), tryGit(repoPath, ['rev-parse', `${base}^{tree}`])])
  return !!tree && !!baseTree && tree.split(/\r?\n/)[0].trim() === baseTree.trim()
}

interface RepoScan {
  repo: WorkRepo
  /** What the tab lists: the repo's own folder while it has work in it, then the linked worktrees. */
  items: WorkItem[]
  /** The repo's own folder, also when it is not listed; null for a bare repo. */
  root: WorkItem | null
  /** Every checkout of the repo, its own included. */
  worktrees: WorktreeEntry[]
  remote: string | null
}

export class WorkManager extends EventEmitter<WorkEvents> {
  readonly journalFile: string
  /** Every command the tab runs, and its output. */
  readonly log: WorkLog
  private deps: WorkDeps
  private file: string
  private state: WorkFile
  private run: WorkRun | null = null
  private child: ChildProcess | null = null
  private runSeq = 0
  private emitTimer: NodeJS.Timeout | null = null
  private agents: { at: number; list: WorkAgent[] } | null = null
  private scans = new Map<string, RepoScan>()
  /** "<repo key>|<branch>" → the branch the reflog says it was made from, or null; it does not change. */
  private origins = new Map<string, string | null>()
  private gh: { at: number; ok: boolean } | null = null
  /** "<repo key>|<branch>" → its open pull request: one made here, or one the last refresh found. Not kept between runs of the app. */
  private prs = new Map<string, WorkPr>()

  constructor(deps: WorkDeps) {
    super()
    this.deps = deps
    this.file = path.join(deps.dataDir, 'work.json')
    this.journalFile = path.join(deps.dataDir, 'work', 'journal.jsonl')
    this.log = new WorkLog(path.join(deps.dataDir, 'work', 'commands.log'))
    let raw: any = null
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {}
    this.state = {
      agent: raw?.agent === 'claude' || raw?.agent === 'codex' ? raw.agent : null,
      lastRepo: typeof raw?.lastRepo === 'string' ? raw.lastRepo : null,
      repos: Array.isArray(raw?.repos) ? raw.repos.filter((r: unknown) => typeof r === 'string') : [],
      bases: raw?.bases && typeof raw.bases === 'object' ? raw.bases : {},
      setup: { copyEnv: raw?.setup?.copyEnv !== false, deps: ['link', 'install'].includes(raw?.setup?.deps) ? raw.setup.deps : 'none' }
    }
  }

  /** git, written to the command log. Everything an action runs goes through here. */
  private act(cwd: string, args: string[], timeout?: number): Promise<string> {
    return git(cwd, args, timeout, this.log)
  }

  private tryAct(cwd: string, args: string[], timeout?: number): Promise<string | null> {
    return tryGit(cwd, args, timeout, this.log)
  }

  private save(): void {
    try {
      writeJson(this.file, this.state)
    } catch {}
  }

  private journal(e: Omit<WorkJournalEntry, 'at'>): void {
    try {
      mkdirSync(path.dirname(this.journalFile), { recursive: true })
      appendFileSync(this.journalFile, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n')
    } catch {}
  }

  private journalOf(item: WorkItem, action: WorkJournalEntry['action'], ok: boolean, extra: { agent?: WorkAgent; detail?: string; url?: string } = {}): void {
    this.journal({ action, repo: item.repo, repoPath: item.repoPath, worktree: item.name, branch: item.branch, base: item.base, ok, ...extra })
  }

  readJournal(limit = JOURNAL_SHOWN): WorkJournalEntry[] {
    try {
      const lines = readFileSync(this.journalFile, 'utf8').split('\n').filter(Boolean)
      return lines.slice(-limit).reverse().flatMap((l) => {
        try {
          return [JSON.parse(l) as WorkJournalEntry]
        } catch {
          return []
        }
      })
    } catch {
      return []
    }
  }

  private async installedAgents(): Promise<WorkAgent[]> {
    if (this.agents && Date.now() - this.agents.at < 60_000) return this.agents.list
    const list = this.deps.detectAgents ? await this.deps.detectAgents() : (await Promise.all((['claude', 'codex'] as const).map(async (a) => ((await onPath(AGENT_BIN[a])) ? [a] : [])))).flat()
    this.agents = { at: Date.now(), list }
    return list
  }

  private async hasGh(): Promise<boolean> {
    if (this.gh && Date.now() - this.gh.at < 60_000) return this.gh.ok
    this.gh = { at: Date.now(), ok: this.deps.detectGh ? await this.deps.detectGh() : await onPath('gh') }
    return this.gh.ok
  }

  private ghArgv(args: string[]): string[] {
    return this.deps.ghCommand ? this.deps.ghCommand(args) : ['gh', ...args]
  }

  /** Asks GitHub for the repo's open pull requests. What was known stays when that fails, as it does for a repo that is not on GitHub. */
  private async readPrs(repoPath: string): Promise<void> {
    const [bin, ...args] = this.ghArgv(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,url,headRefName'])
    const out = await tryRun(repoPath, bin, args, 30_000, this.log)
    let list: unknown
    try {
      list = JSON.parse(out ?? '')
    } catch {
      return
    }
    if (!Array.isArray(list)) return
    const prefix = `${pathKey(repoPath)}|`
    for (const k of [...this.prs.keys()]) if (k.startsWith(prefix)) this.prs.delete(k)
    for (const p of list) {
      if (typeof p?.headRefName === 'string' && Number.isInteger(p.number) && /^https:\/\//.test(String(p.url))) this.prs.set(prefix + p.headRefName, { number: p.number, url: p.url })
    }
  }

  setAgent(agent: WorkAgent): void {
    this.state.agent = agent
    this.save()
  }

  /** Adds a folder the user picked. Returns why it cannot be used, or null. */
  addRepo(dir: string): string | null {
    if (!isRepoRoot(dir)) return 'That folder is not the root of a git repo.'
    this.rememberRepo(dir)
    return null
  }

  private rememberRepo(dir: string): void {
    this.state.repos = [dir, ...this.state.repos.filter((r) => pathKey(r) !== pathKey(dir))].slice(0, 40)
    this.state.lastRepo = dir
    this.save()
  }

  private repoPaths(): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const p of [...this.state.repos, ...this.deps.knownRepos()]) {
      const k = pathKey(p)
      if (seen.has(k) || !isRepoRoot(p)) continue
      seen.add(k)
      out.push(p)
    }
    return out.slice(0, 40)
  }

  /** Reads one repo: its checkouts, and where its own folder and each linked worktree stand. */
  private async scanRepo(repoPath: string): Promise<RepoScan | null> {
    const listed = await tryGit(repoPath, ['worktree', 'list', '--porcelain'])
    if (listed === null) return null
    const worktrees = parseWorktreeList(listed)
    const repoName = path.basename(repoPath)
    const repo: WorkRepo = { path: repoPath, name: repoName, branch: worktrees[0]?.branch ?? null, branches: [] }
    // Under the path the app knows the repo by, which is also what its sessions have; git may spell it differently.
    const own = worktrees[0] && !worktrees[0].bare ? { ...worktrees[0], path: repoPath } : null
    const linked = worktrees.slice(1).filter((w) => !w.bare)
    if (!own && !linked.length) return { repo, items: [], root: null, worktrees, remote: null }

    const [refsText, remotesText, originHead] = await Promise.all([
      tryGit(repoPath, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', 'refs/heads', 'refs/remotes']),
      tryGit(repoPath, ['remote']),
      tryGit(repoPath, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
    ])
    const refs = new Map<string, { sha: string; at: number }>()
    for (const line of (refsText ?? '').split(/\r?\n/)) {
      const [name, sha, at] = line.split('\t')
      if (name && sha) refs.set(name, { sha, at: Number(at) * 1000 })
    }
    repo.branches = [...refs]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .sort((a, b) => b[1].at - a[1].at)
      .map(([name]) => name.slice('refs/heads/'.length))
    const remotes = (remotesText ?? '').split(/\r?\n/).filter(Boolean)
    const remote = remotes.includes('origin') ? 'origin' : (remotes[0] ?? null)
    const defaultBase = originHead?.trim().replace(/^origin\//, '') || repo.branch || (refs.has('refs/heads/main') ? 'main' : refs.has('refs/heads/master') ? 'master' : null)
    // The repo's own folder is not on the default branch when it is the one with work to merge, so its
    // base is never read from what it has checked out.
    const ownBase = originHead?.trim().replace(/^origin\//, '') || (refs.has('refs/heads/main') ? 'main' : refs.has('refs/heads/master') ? 'master' : null)
    // The worktrees are folders inside the repo's own, so a session belongs to the innermost checkout it is in.
    const checkouts = [...(own ? [own] : []), ...linked].map((w) => pathKey(w.path)).sort((a, b) => b.length - a.length)
    const sessions = this.deps.sessions().map((s) => {
      const key = pathKey(s.homeDir)
      return { in: checkouts.find((c) => inside(key, c)) ?? null, status: s.status }
    })

    /** The branch a branch was made from, when the reflog has it and that branch is still there. Read once. */
    const origin = async (branch: string, dir: string): Promise<string | null> => {
      const cacheKey = `${pathKey(repoPath)}|${branch}`
      let from = this.origins.get(cacheKey)
      if (from === undefined) {
        const log = (cwd: string, ref: string) => tryGit(cwd, ['reflog', 'show', '--format=%H%x09%gs', ref])
        // A linked worktree has a HEAD log of its own; the branch may have been made in either folder.
        const [branchLog, headLog, repoHeadLog] = await Promise.all([log(repoPath, `refs/heads/${branch}`), log(dir, 'HEAD'), pathKey(dir) === pathKey(repoPath) ? null : log(repoPath, 'HEAD')])
        from = createdFrom(branchLog ?? '', `${headLog ?? ''}\n${repoHeadLog ?? ''}`, branch)
        this.origins.set(cacheKey, from)
      }
      // origin/main is main, here or on the remote; a branch made from its own remote copy has no base in that.
      if (from && remote && from.startsWith(`${remote}/`)) from = from.slice(remote.length + 1)
      return from && from !== branch && (refs.has(`refs/heads/${from}`) || (!!remote && refs.has(`refs/remotes/${remote}/${from}`))) ? from : null
    }

    const read = async (w: WorktreeEntry, root: boolean): Promise<WorkItem> => {
      const key = pathKey(w.path)
      const exists = !w.prunable && existsSync(w.path)
      const status = exists ? parseStatus((await tryGit(w.path, ['status', '--porcelain=v2', '--branch'])) ?? '') : null
      const branch = w.branch
      const head = (branch && refs.get(`refs/heads/${branch}`)?.sha) || w.head
      // The base is where the branch came from: what the app recorded when it made the worktree, else
      // what git's reflog says, and only without either the default branch.
      const recorded = branch ? this.state.bases[`${pathKey(repoPath)}|${branch}`] : undefined
      const fallback = root ? ownBase : defaultBase
      const base = recorded ?? (branch && exists ? await origin(branch, w.path) : null) ?? (fallback !== branch ? fallback : null)

      // Merged when the base (here, or on the remote as last fetched) has every commit, or when merging
      // the branch into it would change nothing, which is how a squash merge shows.
      let merged = false
      let least: number | null = null
      if (head && base) {
        const candidates = [`refs/heads/${base}`, ...(remote ? [`refs/remotes/${remote}/${base}`] : [])].filter((r) => refs.has(r))
        for (const cand of candidates) {
          const count = refs.get(cand)!.sha === head ? 0 : Number((await tryGit(repoPath, ['rev-list', '--count', `${cand}..${head}`]))?.trim() ?? NaN)
          if (!Number.isFinite(count)) continue
          least = least === null ? count : Math.min(least, count)
          if (count === 0 || (await addsNothing(repoPath, cand, head))) {
            merged = true
            break
          }
        }
      }
      const ahead = merged ? 0 : (least ?? 0)
      // A branch that was only ever created has one reflog entry.
      let everCommitted = false
      if (merged && branch && !root) everCommitted = ((await tryGit(repoPath, ['reflog', 'show', '--format=%h', `refs/heads/${branch}`])) ?? '').split(/\r?\n/).filter(Boolean).length > 1
      const here = sessions.filter((s) => s.in === key)
      const busy = here.some((s) => s.status === 'busy')
      const changed = status?.changed ?? 0
      const state = root ? rootState({ busy, changed, ahead, toPush: status?.toPush ?? null }) : workState({ exists, busy, changed, merged, everCommitted })
      return {
        key,
        repoPath,
        repo: repoName,
        root,
        name: path.basename(w.path),
        path: w.path,
        branch,
        base,
        state,
        changed,
        ahead,
        locked: w.locked,
        toPush: status?.toPush ?? null,
        hasRemote: !!remote,
        sessionOpen: here.some((s) => s.status !== 'closed'),
        lastCommitAt: (branch && refs.get(`refs/heads/${branch}`)?.at) || null,
        pr: (branch && this.prs.get(`${pathKey(repoPath)}|${branch}`)) || null
      }
    }
    const [root, ...items] = await Promise.all([own ? read(own, true) : null, ...linked.map((w) => read(w, false))])
    // The repo's own folder is listed only while something in it is left to commit, merge or push.
    return { repo, items: [...(root && root.state !== 'ready' ? [root] : []), ...(items as WorkItem[])], root, worktrees, remote }
  }

  private scanning: Promise<void> | null = null

  private async scanAll(): Promise<void> {
    this.scanning ??= (async () => {
      try {
        const paths = this.repoPaths()
        const results = await Promise.all(paths.map((p) => this.scanRepo(p)))
        this.scans = new Map(results.flatMap((r) => (r ? [[pathKey(r.repo.path), r] as const] : [])))
      } finally {
        this.scanning = null
      }
    })()
    await this.scanning
  }

  /** Everything the tab shows. With fetch, asks each repo's remote first, so merges done elsewhere show. */
  async overview(opts: { fetch?: boolean } = {}): Promise<WorkOverview> {
    if (opts.fetch) {
      await this.scanAll()
      const withRemote = [...this.scans.values()].filter((s) => s.remote && s.items.length)
      const gh = withRemote.length > 0 && (await this.hasGh())
      if (withRemote.length) this.log.action(`Refresh: fetch from the remotes${gh ? ' and read the open pull requests' : ''}`)
      // One at a time, so their output does not mix in the log.
      for (const s of withRemote) {
        await this.tryAct(s.repo.path, ['fetch', '--prune', s.remote!], 30_000)
        if (gh) await this.readPrs(s.repo.path)
      }
    }
    await this.scanAll()
    const agents = await this.installedAgents()
    const scans = [...this.scans.values()]
    const lastRepo = this.state.lastRepo && this.scans.has(pathKey(this.state.lastRepo)) ? this.state.lastRepo : null
    return {
      agents,
      agent: this.state.agent && agents.includes(this.state.agent) ? this.state.agent : (agents[0] ?? null),
      gh: await this.hasGh(),
      repos: scans.map((s) => s.repo),
      lastRepo,
      items: scans.flatMap((s) => s.items),
      journal: this.readJournal(),
      setup: this.state.setup,
      run: this.run
    }
  }

  /** The item as it is right now; actions never trust what the window last showed. */
  private async fresh(key: string): Promise<{ item: WorkItem; scan: RepoScan }> {
    const known = [...this.scans.values()].find((s) => s.root?.key === key || s.items.some((i) => i.key === key))
    const scan = known ? await this.scanRepo(known.repo.path) : null
    // The repo's own folder is still there after its last work is committed or pushed, when the list drops it.
    const item = scan?.items.find((i) => i.key === key) ?? (scan?.root?.key === key ? scan.root : undefined)
    if (!scan || !item) throw new Error('This worktree is no longer there.')
    this.scans.set(pathKey(scan.repo.path), scan)
    return { item, scan }
  }

  // ---------- create ----------

  /** What the repo has that a new worktree can bring along. Only reads. */
  async setupInfo(repoPath: string): Promise<WorkSetupInfo> {
    const list = async (args: string[]) => ((await tryGit(repoPath, ['ls-files', '-z', ...args])) ?? '').split('\0').filter(Boolean)
    const [envFiles, packages] = await Promise.all([
      // Untracked only: the tracked ones (.env.example) are in the worktree already.
      list(['--others', '--', ':(glob)**/.env*', ':(exclude,glob)**/node_modules/**', ':(exclude).claude']),
      list(['--', ':(glob)**/package.json'])
    ])
    const nodeModules = packages
      .map((p) => path.posix.dirname(p).replace(/^\.$/, ''))
      .filter((dir) => existsSync(path.join(repoPath, dir, 'node_modules')))
      .sort()
    return { envFiles: envFiles.slice(0, 200), nodeModules: nodeModules.slice(0, 200), install: installCommand(repoPath) }
  }

  /** Copies the repo's untracked .env* files into the worktree, leaving alone what is already there. */
  private copyEnvFiles(repoPath: string, dir: string, files: string[]): number {
    let copied = 0
    for (const rel of files) {
      try {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
        copyFileSync(path.join(repoPath, rel), path.join(dir, rel), constants.COPYFILE_EXCL)
        this.log.note(`copied ${rel} from ${repoPath} to ${dir}`)
        copied++
      } catch (e: any) {
        this.log.note(`did not copy ${rel}: ${e?.code === 'EEXIST' ? 'it is already in the worktree' : (e?.message ?? e)}`)
      }
    }
    return copied
  }

  /** Links each node_modules of the repo into the same place in the worktree: a junction on Windows, a symlink elsewhere. */
  private async linkNodeModules(repoPath: string, dir: string, folders: string[]): Promise<number> {
    let linked = 0
    for (const rel of folders) {
      const target = path.join(repoPath, rel, 'node_modules')
      const link = path.join(dir, rel, 'node_modules')
      try {
        if (!existsSync(path.join(dir, rel))) continue
        symlinkSync(target, link, 'junction')
        this.log.note(`linked ${link} to ${target}`)
        linked++
      } catch (e: any) {
        this.log.note(`did not link ${link}: ${e?.message ?? e}`)
      }
    }
    // Without an ignore rule the whole of node_modules would show as new files, for an agent to commit.
    if (linked && (await this.tryAct(dir, ['check-ignore', '-q', 'node_modules'])) === null) {
      try {
        const file = path.join(repoPath, '.git', 'info', 'exclude')
        const old = existsSync(file) ? readFileSync(file, 'utf8') : ''
        appendFileSync(file, `${old && !old.endsWith('\n') ? '\n' : ''}node_modules\n`)
        this.log.note(`added the line node_modules to ${file}`)
      } catch {}
    }
    return linked
  }

  /** Runs the package manager's install in the worktree. Returns when it has started. */
  async install(key: string): Promise<void> {
    const { item } = await this.fresh(key)
    if (item.state === 'orphaned') throw new Error('The folder of this worktree is gone.')
    const command = installCommand(item.path)
    if (!command) throw new Error('There is no package.json in the root of this worktree.')
    const run = this.startRun(item, 'install', `${command} in ${item.name}`, null)
    this.log.action(`${command} in ${item.name} (${item.repo})`)
    this.say(run, `$ ${command}\n`)
    const child = spawn(command, { cwd: item.path, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    void this.stream(run, child, item.path, command).then((code) => {
      this.journalOf(item, 'install', code === 0, { detail: command })
      this.endRun(run, code === 0 ? 'ok' : 'failed')
    })
  }

  async create(repoPath: string, rawName: string, opts: WorkCreateOptions = { copyEnv: false, deps: 'none' }): Promise<WorkItem> {
    const name = rawName.trim()
    const bad = worktreeNameError(name)
    if (bad) throw new Error(bad)
    if (!isRepoRoot(repoPath)) throw new Error('That folder is not the root of a git repo.')
    const dir = path.join(repoPath, '.claude', 'worktrees', name)
    if (existsSync(dir)) throw new Error(`There is already a folder at .claude/worktrees/${name}.`)
    this.log.action(`Create worktree ${name} in ${repoPath}`)
    if ((await this.tryAct(repoPath, ['rev-parse', '-q', '--verify', `refs/heads/${name}`])) !== null) throw new Error(`There is already a branch named ${name}.`)
    const base = (await this.tryAct(repoPath, ['branch', '--show-current']))?.trim() || null
    await this.excludeWorktrees(repoPath)
    await this.act(repoPath, ['worktree', 'add', '-b', name, '--', dir], 120_000)
    if (base) this.state.bases[`${pathKey(repoPath)}|${name}`] = base
    const brought: string[] = []
    if (opts.copyEnv || opts.deps === 'link') {
      const info = await this.setupInfo(repoPath)
      const copied = opts.copyEnv ? this.copyEnvFiles(repoPath, dir, info.envFiles) : 0
      if (copied) brought.push(`copied ${plural(copied, '.env file')}`)
      if (opts.deps === 'link' && (await this.linkNodeModules(repoPath, dir, info.nodeModules))) brought.push('linked node_modules')
    }
    this.state.setup = { copyEnv: !!opts.copyEnv, deps: opts.deps }
    this.rememberRepo(repoPath)
    this.journal({ action: 'create', repo: path.basename(repoPath), repoPath, worktree: name, branch: name, base, ok: true, detail: brought.join(', ') || undefined })
    const scan = await this.scanRepo(repoPath)
    if (scan) this.scans.set(pathKey(repoPath), scan)
    const item = scan?.items.find((i) => i.branch === name)
    if (!item) throw new Error('The worktree was created, but git does not list it.')
    this.emit('changed')
    return item
  }

  /** Keeps the worktrees folder out of the repo's own `git status`, in .git/info/exclude, which is never committed. */
  private async excludeWorktrees(repoPath: string): Promise<void> {
    if ((await this.tryAct(repoPath, ['check-ignore', '-q', '.claude/worktrees/x'])) !== null) return
    try {
      const file = path.join(repoPath, '.git', 'info', 'exclude')
      mkdirSync(path.dirname(file), { recursive: true })
      const old = existsSync(file) ? readFileSync(file, 'utf8') : ''
      appendFileSync(file, `${old && !old.endsWith('\n') ? '\n' : ''}/.claude/worktrees/\n`)
      this.log.note(`added the line /.claude/worktrees/ to ${file}`)
    } catch {}
  }

  // ---------- runs: commit, push, merge ----------

  private startRun(item: WorkItem, kind: WorkRun['kind'], title: string, agent: WorkAgent | null): WorkRun {
    if (this.run?.status === 'running') throw new Error('Something is still running. Wait for it, or stop it.')
    this.run = { id: ++this.runSeq, key: item.key, kind, title, agent, text: '', status: 'running' }
    this.emit('run', this.run)
    return this.run
  }

  private say(run: WorkRun, text: string): void {
    if (this.run !== run || !text) return
    run.text += text
    if (run.text.length > MAX_RUN_TEXT) run.text = '…\n' + run.text.slice(-MAX_RUN_TEXT * 0.75)
    this.emitTimer ??= setTimeout(() => {
      this.emitTimer = null
      if (this.run) this.emit('run', { ...this.run })
    }, 80)
  }

  private endRun(run: WorkRun, status: WorkRun['status']): void {
    if (this.run !== run) return
    if (run.status === 'running') run.status = status
    this.child = null
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    this.emit('run', { ...run })
    this.emit('changed')
  }

  /**
   * Follows a command that was just started: what it prints goes to the command log as it is, and to the
   * run, through onLine when the output is not meant for reading. Resolves with its exit code.
   */
  private stream(run: WorkRun, child: ChildProcess, cwd: string, line: string, opts: { onLine?: (line: string) => string; stdin?: string } = {}): Promise<number> {
    const { onLine } = opts
    const started = Date.now()
    this.child = child
    this.log.start(cwd, line)
    if (opts.stdin) this.log.write(`[stdin]\n${opts.stdin}\n[end of stdin]\n`)
    return new Promise((resolve) => {
      let ended = false
      const end = (code: number) => {
        if (ended) return
        ended = true
        this.log.end(code, Date.now() - started)
        resolve(code)
      }
      const feed = (stream: NodeJS.ReadableStream | null, lines: boolean) => {
        let rest = ''
        stream?.setEncoding('utf8')
        stream?.on('data', (d: string) => {
          this.log.write(d)
          if (!lines || !onLine) return this.say(run, d)
          rest += d
          const parts = rest.split('\n')
          rest = parts.pop() ?? ''
          for (const p of parts) this.say(run, onLine(p))
        })
        stream?.on('end', () => rest && onLine && lines && this.say(run, onLine(rest)))
      }
      feed(child.stdout, true)
      feed(child.stderr, false)
      child.on('error', (e) => {
        this.log.note(`could not start: ${e.message}`)
        this.say(run, `${e.message}\n`)
        end(-1)
      })
      child.on('close', (code) => end(code ?? -1))
    })
  }

  private gitStream(run: WorkRun, cwd: string, args: string[]): Promise<number> {
    this.say(run, `$ git ${args.join(' ')}\n`)
    return this.stream(run, spawn('git', args, { cwd, windowsHide: true, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }), cwd, `git ${args.join(' ')}`)
  }

  /** Stops what is running. On Windows the agent runs under a shell, so the whole process tree goes. */
  stop(): void {
    const run = this.run
    const child = this.child
    if (!run || run.status !== 'running' || !child?.pid) return
    run.status = 'stopped'
    this.say(run, '\nStopped.\n')
    if (process.platform === 'win32') {
      this.log.note(`stopped by the user: taskkill /pid ${child.pid} /T /F`)
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      this.log.note('stopped by the user')
      child.kill()
    }
  }

  /** Takes a finished run off the screen. */
  dismissRun(): void {
    if (this.run?.status === 'running') return
    this.run = null
    this.emit('run', null)
  }

  /** Lets the agent commit what is in the worktree. Returns when it has started; the text comes as run events. */
  async commit(key: string, agent: WorkAgent): Promise<void> {
    const { item } = await this.fresh(key)
    if (item.state === 'working') throw new Error('An agent is working in this worktree. Let it finish first.')
    if (item.state === 'orphaned') throw new Error('The folder of this worktree is gone.')
    if (!item.changed) throw new Error('There is nothing to commit.')
    if (!(await this.installedAgents()).includes(agent)) throw new Error(`${AGENT_NAME[agent]} is not installed on this machine.`)
    const run = this.startRun(item, 'commit', `${AGENT_NAME[agent]} commits ${item.name}`, agent)
    this.setAgent(agent)
    this.log.action(`Commit work in ${item.name} (${item.repo}) with ${AGENT_NAME[agent]}`)
    const command = (this.deps.agentCommand ?? agentCommand)(agent, item.repoPath)
    const child = spawn(command, { cwd: item.path, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin?.on('error', () => {})
    child.stdin?.end(COMMIT_PROMPT)
    let agentError = false
    const shellIds = new Set<string>()
    const onLine = (line: string): string => {
      if (agent !== 'claude') return line + '\n'
      try {
        const o = JSON.parse(line)
        if (o?.type === 'result' && o.is_error) agentError = true
        return claudeStreamText(o, shellIds)
      } catch {
        return line.trim() ? line + '\n' : ''
      }
    }
    void this.stream(run, child, item.path, command, { onLine, stdin: COMMIT_PROMPT }).then(async (code) => {
      const after = await this.fresh(key).catch(() => null)
      const ok = code === 0 && !agentError
      if (!ok && run.status === 'running') this.say(run, `\n${AGENT_NAME[agent]} ended with an error${code > 0 ? ` (exit code ${code})` : ''}.\n`)
      else if (after?.item.changed) this.say(run, `\n${plural(after.item.changed, 'file')} still uncommitted.\n`)
      this.journalOf(after?.item ?? item, 'commit', ok, { agent, detail: !ok ? (run.status === 'stopped' ? 'stopped' : 'the agent failed') : after?.item.changed ? 'some files left uncommitted' : undefined })
      this.endRun(run, ok ? 'ok' : 'failed')
    })
  }

  async push(key: string): Promise<void> {
    const { item, scan } = await this.fresh(key)
    if (!item.branch) throw new Error('This worktree is not on a branch.')
    if (!scan.remote) throw new Error('This repo has no remote to push to.')
    const run = this.startRun(item, 'push', `Push ${item.branch}`, null)
    this.log.action(`Push ${item.branch} (${item.repo}) to ${scan.remote}`)
    void this.gitStream(run, item.repoPath, ['push', '-u', scan.remote, item.branch]).then((code) => {
      this.journalOf(item, 'push', code === 0, { detail: `to ${scan.remote}` })
      this.endRun(run, code === 0 ? 'ok' : 'failed')
    })
  }

  async prPlan(key: string): Promise<PrPlan> {
    const { item, scan } = await this.fresh(key)
    if (!(await this.hasGh())) throw new Error('Pull requests are made with the GitHub CLI (gh), which was not found on this machine.')
    if (!item.branch) throw new Error('This worktree is not on a branch.')
    if (!scan.remote) throw new Error('This repo has no remote to open a pull request on.')
    if (!item.base) throw new Error('There is no base branch to open the pull request into.')
    if (item.state === 'working') throw new Error('An agent is working in this worktree. Let it finish first.')
    if (item.changed) throw new Error('Commit the work first; it has uncommitted files.')
    if (!item.ahead) throw new Error(`${item.branch} has no commits that are not in ${item.base}.`)
    if ((await tryGit(item.repoPath, ['rev-parse', '-q', '--verify', `refs/remotes/${scan.remote}/${item.base}`])) === null) throw new Error(`${item.base} is not on ${scan.remote}, so there is nothing there to open the pull request into.`)
    return { item, base: item.base, remote: scan.remote, push: item.toPush !== 0 }
  }

  /**
   * Opens a pull request for the branch into its base with the GitHub CLI, after pushing the branch when
   * the remote does not have it as it is here. The title and the description come from the commits.
   */
  async pr(key: string): Promise<void> {
    const plan = await this.prPlan(key)
    const { item, base, remote } = plan
    const branch = item.branch!
    const run = this.startRun(item, 'pr', `Pull request for ${branch} into ${base}`, null)
    this.log.action(`Open a pull request for ${branch} into ${base} (${item.repo})`)
    void (async () => {
      let code = plan.push ? await this.gitStream(run, item.repoPath, ['push', '-u', remote, branch]) : 0
      let made: WorkPr | null = null
      if (code === 0 && run.status === 'running') {
        const [bin, ...args] = this.ghArgv(['pr', 'create', '--base', base, '--head', branch, '--fill'])
        const line = [bin, ...args].join(' ')
        this.say(run, `$ ${line}\n`)
        const from = run.text.length
        code = await this.stream(run, spawn(bin, args, { cwd: item.path, windowsHide: true, env: GH_ENV, stdio: ['ignore', 'pipe', 'pipe'] }), item.path, line)
        // Also when it failed because the branch has one already: the link to that one is in what it said.
        made = prInText(run.text.slice(from))
        if (made) this.prs.set(`${pathKey(item.repoPath)}|${branch}`, made)
      }
      this.journalOf(item, 'pr', code === 0, { detail: `into ${base}`, url: made?.url })
      this.endRun(run, code === 0 ? 'ok' : 'failed')
    })()
  }

  async mergePlan(key: string, into?: string): Promise<MergePlan> {
    const { item, scan } = await this.fresh(key)
    if (!item.branch) throw new Error('This worktree is not on a branch.')
    const target = into ?? item.base
    if (!target) throw new Error('Pick the branch to merge into.')
    if (target === item.branch) throw new Error('A branch cannot be merged into itself.')
    if (!scan.repo.branches.includes(target)) throw new Error(`There is no local branch named ${target}.`)
    if (item.state === 'working') throw new Error('An agent is working in this worktree. Let it finish first.')
    if (item.changed) throw new Error('Commit the work first; it has uncommitted files.')
    return { item, into: target, target: scan.worktrees.find((w) => w.branch === target && !w.prunable)?.path ?? null }
  }

  /**
   * Merges the worktree's branch into another branch, its base unless one is given. Where that branch is
   * checked out, the merge runs in that folder. Where it is not, the branch is moved forward if it can be,
   * and otherwise the merge is made in a checkout that only exists for the merge.
   */
  async merge(key: string, into?: string): Promise<void> {
    const plan = await this.mergePlan(key, into)
    const { item, target } = plan
    const branch = item.branch!
    const run = this.startRun(item, 'merge', `Merge ${branch} into ${plan.into}`, null)
    this.log.action(`Merge ${branch} into ${plan.into} (${item.repo})`)
    const conflicts = `\nThe merge has conflicts, so it was undone. Merge ${branch} into ${plan.into} by hand.\n`
    /** Merges in a folder that has the target checked out; a merge that stops on conflicts is undone. */
    const mergeIn = async (dir: string): Promise<number> => {
      const code = await this.gitStream(run, dir, ['merge', '--no-edit', branch])
      if (code !== 0 && run.status === 'running' && (await this.tryAct(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) !== null) {
        await this.tryAct(dir, ['merge', '--abort'])
        this.say(run, conflicts)
      }
      return code
    }
    void (async () => {
      let code: number
      if (target) code = await mergeIn(target)
      else {
        code = await this.gitStream(run, item.repoPath, ['fetch', '.', `${branch}:${plan.into}`])
        if (code !== 0 && run.status === 'running') {
          this.say(run, `\n${plan.into} has commits of its own, so it cannot just be moved forward. Merging in a temporary checkout of it.\n`)
          const tmp = mkdtempSync(path.join(os.tmpdir(), 'vsm-merge-'))
          try {
            code = await this.gitStream(run, item.repoPath, ['worktree', 'add', tmp, plan.into])
            if (code === 0) code = await mergeIn(tmp)
          } finally {
            await this.tryAct(item.repoPath, ['worktree', 'remove', '--force', tmp])
            rmSync(tmp, { recursive: true, force: true })
            await this.tryAct(item.repoPath, ['worktree', 'prune'])
          }
        }
      }
      this.journalOf(item, 'merge', code === 0, { detail: `into ${plan.into}` })
      this.endRun(run, code === 0 ? 'ok' : 'failed')
    })()
  }

  // ---------- cleanup ----------

  async cleanupPlan(key: string): Promise<CleanupPlan> {
    const { item } = await this.fresh(key)
    const plan: CleanupPlan = { item, blocked: null, losses: [], notes: [] }
    if (item.root) plan.blocked = "This is the repo's own folder, not a worktree. It is not removed."
    else if (this.run?.status === 'running' && this.run.key === key) plan.blocked = 'Something is still running on this worktree.'
    else if (item.state === 'working') plan.blocked = 'An agent is working in this worktree. Let it finish first.'
    else if (item.locked && item.state !== 'orphaned') plan.blocked = 'Git has this worktree locked, which an agent does while it runs in it. Close that session first.'
    if (item.changed) plan.losses.push(`${plural(item.changed, 'uncommitted file')} will be lost.`)
    const unmerged = item.state === 'pending-merge' || (item.state === 'uncommitted' && item.ahead > 0) || (item.state === 'orphaned' && item.ahead > 0)
    if (unmerged && item.branch) {
      const where = item.base ? `not in ${item.base}` : 'not merged anywhere'
      plan.losses.push(item.toPush === 0 ? `${plural(item.ahead, 'commit')} on ${item.branch} ${item.ahead === 1 ? 'is' : 'are'} ${where}. The branch stays on the remote.` : `${plural(item.ahead, 'commit')} on ${item.branch} ${item.ahead === 1 ? 'is' : 'are'} ${where} and will be lost.`)
    }
    if (!item.branch && item.state !== 'orphaned') plan.notes.push('The worktree is not on a branch, so only the folder is removed.')
    if (item.sessionOpen) plan.notes.push('A session is still open in this folder.')
    return plan
  }

  /** Removes the worktree and deletes its branch. With losses in the plan, only when force is set. */
  async cleanup(key: string, force: boolean): Promise<string> {
    const plan = await this.cleanupPlan(key)
    const { item } = plan
    if (plan.blocked) throw new Error(plan.blocked)
    if (plan.losses.length && !force) throw new Error(plan.losses.join(' '))
    this.log.action(`Clean up ${item.name} (${item.repo})${force && plan.losses.length ? `, discarding: ${plan.losses.join(' ')}` : ''}`)
    try {
      if (item.state === 'orphaned') await this.act(item.repoPath, ['worktree', 'prune'])
      else {
        // First, or git would delete the repo's own node_modules through the link.
        for (const link of unlinkNodeModules(item.path)) this.log.note(`removed the link ${link}`)
        await this.act(item.repoPath, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', item.path], 120_000)
      }
    } catch (e: any) {
      this.journalOf(item, 'cleanup', false, { detail: String(e?.message ?? e).split('\n')[0] })
      throw new Error(`Could not remove the folder: ${String(e?.message ?? e).split('\n')[0]} Close the editor window on it and try again.`)
    }
    let message = `Removed worktree ${item.name}`
    if (item.branch) {
      try {
        // -d refuses a squash-merged branch; by now it is either verified as merged or the user said to drop it.
        await this.act(item.repoPath, ['branch', '-d', item.branch]).catch(() => this.act(item.repoPath, ['branch', '-D', item.branch!]))
        message += ` and branch ${item.branch}`
      } catch (e: any) {
        message += `, but not branch ${item.branch}: ${String(e?.message ?? e).split('\n')[0]}`
      }
      delete this.state.bases[`${pathKey(item.repoPath)}|${item.branch}`]
      this.origins.delete(`${pathKey(item.repoPath)}|${item.branch}`)
      this.prs.delete(`${pathKey(item.repoPath)}|${item.branch}`)
      this.save()
    }
    await this.tryAct(item.repoPath, ['worktree', 'prune'])
    this.journalOf(item, 'cleanup', true, { detail: force && plan.losses.length ? 'discarded unmerged work' : undefined })
    const scan = await this.scanRepo(item.repoPath)
    if (scan) this.scans.set(pathKey(item.repoPath), scan)
    this.emit('changed')
    return message + '.'
  }
}
