import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { agentCommand, claudeStreamText, createdFrom, installCommand, parseStatus, parseWorktreeList, prInText, rootState, unlinkNodeModules, WorkManager, workState, worktreeNameError } from '../../src/core/work.ts'
import type { LiveStatus, WorkRun } from '../../src/shared/types.ts'
import { tmpDir } from './helpers.ts'

// These run real git many times; on Windows CI runners that takes longer than the 5 s default.
vi.setConfig({ testTimeout: 30_000 })

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

describe('reading git output', () => {
  it('reads the worktree list', () => {
    const list = parseWorktreeList(
      ['worktree C:/dev/repo', 'HEAD 1111', 'branch refs/heads/main', '', 'worktree C:/dev/repo/.claude/worktrees/fix', 'HEAD 2222', 'branch refs/heads/feat/fix', 'locked', '', 'worktree C:/dev/repo/.claude/worktrees/gone', 'HEAD 3333', 'detached', 'prunable gitdir file points to non-existent location', ''].join('\n')
    )
    expect(list.map((w) => [path.basename(w.path), w.branch, w.locked, w.prunable])).toEqual([
      ['repo', 'main', false, false],
      ['fix', 'feat/fix', true, false],
      ['gone', null, false, true]
    ])
  })

  it('reads the status', () => {
    const s = parseStatus(['# branch.oid 1111', '# branch.head fix', '# branch.upstream origin/fix', '# branch.ab +2 -0', '1 .M N... 100644 100644 100644 1 1 a.txt', '? new.txt'].join('\n'))
    expect(s).toEqual({ branch: 'fix', upstream: 'origin/fix', toPush: 2, changed: 2 })
    expect(parseStatus('# branch.oid 1\n# branch.head (detached)\n')).toEqual({ branch: null, upstream: null, toPush: null, changed: 0 })
  })

  it('decides the state in order', () => {
    const f = { exists: true, busy: false, changed: 0, merged: false, everCommitted: true }
    expect(workState({ ...f, exists: false, busy: true })).toBe('orphaned')
    expect(workState({ ...f, busy: true, changed: 3 })).toBe('working')
    expect(workState({ ...f, changed: 3, merged: true })).toBe('uncommitted')
    expect(workState({ ...f, merged: true, everCommitted: false })).toBe('new')
    expect(workState({ ...f, merged: true })).toBe('ready')
    expect(workState(f)).toBe('pending-merge')
  })

  it('reads from the reflog what a branch was made from', () => {
    const head = ['2222\tcommit: later', '1111\tcheckout: moving from develop to feat', '1111\tcheckout: moving from main to develop', '1111\tcommit (initial): first'].join('\n')
    expect(createdFrom('2222\tcommit: later\n1111\tbranch: Created from HEAD\n', head, 'feat')).toBe('develop')
    expect(createdFrom('1111\tbranch: Created from develop\n', '', 'feat')).toBe('develop')
    expect(createdFrom('1111\tbranch: Created from origin/main\n', '', 'feat')).toBe('origin/main')
    expect(createdFrom('1111\tbranch: Created from refs/remotes/origin/main\n', '', 'feat')).toBe('origin/main')
    // Made with `git branch` and checked out later from somewhere else: that checkout is at another commit.
    expect(createdFrom('1111\tbranch: Created from HEAD\n', '3333\tcheckout: moving from other to feat\n', 'feat')).toBeNull()
    expect(createdFrom('1111\tbranch: Created from HEAD\n', `1111\tcheckout: moving from ${'a'.repeat(40)} to feat\n`, 'feat')).toBeNull()
    expect(createdFrom('1111\tclone: from https://example.com/r.git\n', head, 'main')).toBeNull()
    expect(createdFrom('', head, 'feat')).toBeNull()
  })

  it("lists the repo's own folder only for what is left to do", () => {
    const f = { busy: false, changed: 0, ahead: 0, toPush: 0 as number | null }
    expect(rootState(f)).toBe('ready')
    expect(rootState({ ...f, busy: true })).toBe('ready')
    expect(rootState({ ...f, toPush: null })).toBe('ready')
    expect(rootState({ ...f, busy: true, changed: 1 })).toBe('working')
    expect(rootState({ ...f, changed: 1, ahead: 2, toPush: 2 })).toBe('uncommitted')
    expect(rootState({ ...f, ahead: 2, toPush: 2 })).toBe('pending-merge')
    expect(rootState({ ...f, toPush: 2 })).toBe('unpushed')
  })

  it('accepts only names that work as a folder and a branch', () => {
    expect(worktreeNameError('fix-login_2')).toBeNull()
    for (const bad of ['', 'feat/x', '-x', 'a b', 'a..b', 'x.lock', 'x.', '../up']) expect(worktreeNameError(bad)).not.toBeNull()
  })

  it('shows what the agent says and runs', () => {
    const line = { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Bash', input: { command: 'git status' } }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } }] } }
    expect(claudeStreamText(line)).toBe('Looking.\n\n$ git status\n[Read a.txt]\n')
    // The output of its commands shows; what it read does not, unless that failed.
    const ids = new Set<string>()
    const use = (id: string, name: string, input: object) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
    const result = (id: string, content: unknown, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } })
    expect(claudeStreamText(use('t1', 'PowerShell', { command: 'git add a.txt' }), ids)).toBe('$ git add a.txt\n')
    expect(claudeStreamText(result('t1', 'This command requires approval', true), ids)).toBe('This command requires approval\n')
    claudeStreamText(use('t2', 'Bash', { command: 'git commit -m x' }), ids)
    expect(claudeStreamText(result('t2', [{ type: 'text', text: '[fix 2c47686] x\n 1 file changed' }]), ids)).toBe('[fix 2c47686] x\n 1 file changed\n')
    claudeStreamText(use('t3', 'Read', { file_path: 'a.txt' }), ids)
    expect(claudeStreamText(result('t3', '1\tsecret'), ids)).toBe('')
    claudeStreamText(use('t4', 'Bash', { command: 'git log' }), ids)
    expect(claudeStreamText(result('t4', Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')), ids)).toMatch(/line 39\n… 10 more lines, see the command log\n$/)
    claudeStreamText(use('t5', 'Bash', { command: 'git add .' }), ids)
    expect(claudeStreamText(result('t5', '(Bash completed with no output)'), ids)).toBe('')
    expect(claudeStreamText({ type: 'result', is_error: false, result: 'Done' })).toBe('')
    expect(claudeStreamText({ type: 'result', is_error: true, result: 'Not logged in' })).toBe('Not logged in\n')
    expect(claudeStreamText({ type: 'system', subtype: 'init' })).toBe('')
  })

  it('lets Claude only look, stage and commit', () => {
    const cmd = agentCommand('claude', 'C:\\dev\\repo')
    expect(cmd).toContain('"Bash(git commit:*)"')
    expect(cmd).toContain('"PowerShell(git add:*)"')
    expect(cmd).not.toContain('push')
  })
})

const GH_STAND_IN = `const a = process.argv.slice(1); console.log(a.includes('list') ? JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7', headRefName: 'listed' }]) : 'https://github.com/o/r/pull/8')`

function setup(sessions: { homeDir: string; status: LiveStatus }[] = []) {
  const root = tmpDir()
  const repo = path.join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  const work = new WorkManager({
    dataDir: path.join(root, 'data'),
    knownRepos: () => [repo],
    sessions: () => sessions,
    detectAgents: async () => ['claude'],
    // Stands in for the agent: commits everything, like the real one is asked to.
    agentCommand: () => 'git add -A && git commit -q -m "by the agent" && echo committed',
    detectGh: async () => true,
    // Stands in for the GitHub CLI: one open pull request in the list, and a link for the one it makes.
    ghCommand: (args) => [process.execPath, '-e', GH_STAND_IN, ...args]
  })
  const item = async (name: string) => (await work.overview()).items.find((i) => i.name === name)
  const finished = () =>
    new Promise<WorkRun>((resolve) => {
      const on = (r: WorkRun | null) => {
        if (!r || r.status === 'running') return
        work.off('run', on)
        resolve(r)
      }
      work.on('run', on)
    })
  return { root, repo, work, item, finished, sessions }
}

describe('a worktree from start to cleanup', () => {
  it('goes from new to uncommitted, pending merge, ready and gone', async () => {
    const { repo, work, item, finished } = setup()
    const made = await work.create(repo, 'fix-login')
    // Not compared in full: git reports the long form of a temp folder that Windows hands out in its short form.
    expect(made.path.endsWith(path.join('repo', '.claude', 'worktrees', 'fix-login'))).toBe(true)
    expect(existsSync(path.join(repo, '.claude', 'worktrees', 'fix-login', 'a.txt'))).toBe(true)
    expect(made).toMatchObject({ branch: 'fix-login', base: 'main', state: 'new', changed: 0, ahead: 0 })
    expect(git(made.path, 'branch', '--show-current')).toBe('fix-login')
    // The worktrees folder does not show as untracked in the repo itself.
    expect(git(repo, 'status', '--porcelain')).toBe('')

    writeFileSync(path.join(made.path, 'b.txt'), 'b\n')
    expect(await item('fix-login')).toMatchObject({ state: 'uncommitted', changed: 1 })
    await expect(work.mergePlan(made.key)).rejects.toThrow(/uncommitted/)

    let done = finished()
    await work.commit(made.key, 'claude')
    expect(await done).toMatchObject({ kind: 'commit', status: 'ok' })
    expect(await item('fix-login')).toMatchObject({ state: 'pending-merge', changed: 0, ahead: 1, toPush: null, hasRemote: false })

    done = finished()
    await work.merge(made.key)
    expect((await done).status).toBe('ok')
    expect(existsSync(path.join(repo, 'b.txt'))).toBe(true)
    expect(await item('fix-login')).toMatchObject({ state: 'ready', ahead: 0 })

    expect(await work.cleanup(made.key, false)).toBe('Removed worktree fix-login and branch fix-login.')
    expect(existsSync(made.path)).toBe(false)
    expect(git(repo, 'branch', '--list', 'fix-login')).toBe('')
    expect(await item('fix-login')).toBeUndefined()
    expect(work.readJournal().map((e) => [e.action, e.worktree, e.base, e.ok])).toEqual([
      ['cleanup', 'fix-login', 'main', true],
      ['merge', 'fix-login', 'main', true],
      ['commit', 'fix-login', 'main', true],
      ['create', 'fix-login', 'main', true]
    ])

    // The command log has each command as it was run, what it printed and how it ended.
    const log = readFileSync(work.log.file, 'utf8')
    expect(log).toMatch(/===== \S+  Create worktree fix-login in /)
    expect(log).toMatch(/\] .*repo> git --no-optional-locks worktree add -b fix-login -- .*fix-login\n[^]*?\[exit 0 · \d+ ms\]/)
    expect(log).toContain('> git add -A && git commit -q -m "by the agent" && echo committed\n[stdin]\nCommit the work in this git worktree.')
    expect(log).toMatch(/\[end of stdin\]\n[^]*?committed\s*\n\[exit 0 · \d+ ms\]/)
    expect(log).toMatch(/> git merge --no-edit fix-login\n[^]*b\.txt[^]*?\[exit 0/)
    expect(log).toMatch(/git --no-optional-locks worktree remove -- .*fix-login\n\[exit 0/)
    expect(log).toMatch(/git --no-optional-locks branch -d fix-login\nDeleted branch fix-login[^\n]*\n\[exit 0/)
    // Reading where things stand is not in it.
    expect(log).not.toContain('status --porcelain')
    expect(work.log.tail().text).toBe(log)
    expect(work.log.tail(200).truncated).toBe(true)
  })

  it('finds in the command log what was run for one worktree, and for one action of the history', async () => {
    const { repo, work, finished } = setup()
    const one = await work.create(repo, 'one')
    const two = await work.create(repo, 'two')
    writeFileSync(path.join(one.path, 'b.txt'), 'b\n')
    const done = finished()
    await work.commit(one.key, 'claude')
    await done

    const ofOne = work.log.of({ worktree: one.key }).text
    expect(ofOne).toMatch(/^===== \S+  Create worktree one in [^]*===== \S+  Commit work in one \(repo\) with Claude Code =====\n\[worktree .*one\]\n[^]*committed\s*\n\[exit 0 · \d+ ms\]\n$/)
    expect(ofOne).not.toContain('worktree add -b two')
    const ofTwo = work.log.of({ worktree: two.path })
    expect(ofTwo.text).toMatch(/^===== \S+  Create worktree two in /)
    expect(ofTwo.text).not.toContain('Commit work')
    expect(ofTwo.truncated).toBe(false)
    expect(work.log.of({ worktree: one.key }, 200).truncated).toBe(true)
    expect(work.log.of({ worktree: path.join(repo, 'nowhere') }).text).toBe('')

    // Each line of the history knows its own part of the log.
    const [commit, , created] = work.readJournal()
    expect(commit).toMatchObject({ action: 'commit', worktree: 'one' })
    expect(work.log.of({ id: commit.log }).text).toMatch(/^===== \S+  Commit work in one [^]*\[exit 0 · \d+ ms\]\n$/)
    expect(work.log.of({ id: created.log }).text).toMatch(/^===== \S+  Create worktree one in [^]*worktree add -b one/)
    expect(work.log.of({ id: created.log }).text).not.toContain('Create worktree two')

    // It is still found when the worktree is gone.
    await work.cleanup(two.key, false)
    expect(work.log.of({ id: work.readJournal()[0].log }).text).toMatch(/^===== \S+  Clean up two \(repo\) =====\n\[worktree .*two\]\n[^]*branch -d two/)
  })

  it('keeps what a command prints with its own action when another one is logged meanwhile', () => {
    const { root, work } = setup()
    const dir = path.join(root, 'wt')
    const long = work.log.action('Commit work in wt', dir)
    work.log.start(dir, 'agent')
    work.log.write('first\n')
    work.log.action('Refresh')
    work.log.command(root, 'git fetch', 'fetched\n', 0, 1)
    work.log.resume(long)
    work.log.write('second\n')
    work.log.resume(long)
    work.log.end(0, 5)

    const text = work.log.of({ id: long.id }).text
    expect(text).toMatch(/first\n\n===== \S+  Commit work in wt, continued from \S+ =====\n\[worktree .*wt\]\nsecond\n\[exit 0 · 5 ms\]\n$/)
    expect(text).not.toContain('fetched')
    expect(work.log.of({ worktree: dir }).text).toBe(text)
  })

  it('logs a command that fails, with what git said', async () => {
    const { repo, work } = setup()
    git(repo, 'branch', 'taken')
    await expect(work.create(repo, 'taken')).rejects.toThrow(/already a branch/)
    const made = await work.create(repo, 'held')
    git(repo, 'worktree', 'lock', made.path)
    await expect(work.cleanup(made.key, false)).rejects.toThrow(/locked/)
    git(repo, 'worktree', 'unlock', made.path)
    writeFileSync(path.join(made.path, 'b.txt'), 'b\n')
    // Git itself refuses to remove a folder with changes; the refusal is in the log.
    await expect((work as any).act(repo, ['worktree', 'remove', '--', made.path])).rejects.toThrow()
    expect(readFileSync(work.log.file, 'utf8')).toMatch(/worktree remove -- .*held\n.*(untracked|modified)[^]*?\[exit (128|1) /)
  })

  it('refuses a name that is taken', async () => {
    const { repo, work } = setup()
    await work.create(repo, 'one')
    await expect(work.create(repo, 'one')).rejects.toThrow(/already/)
    git(repo, 'branch', 'two')
    await expect(work.create(repo, 'two')).rejects.toThrow(/already a branch/)
    await expect(work.create(repo, 'a/b')).rejects.toThrow()
  })

  it('remembers the branch it was created from as the base', async () => {
    const { repo, work, item } = setup()
    git(repo, 'checkout', '-q', '-b', 'develop')
    await work.create(repo, 'from-develop')
    git(repo, 'checkout', '-q', 'main')
    expect((await item('from-develop'))?.base).toBe('develop')
    expect((await work.overview()).repos[0]).toMatchObject({ name: 'repo', branch: 'main' })
  })

  it('sees a squash merge as merged', async () => {
    const { repo, work, item } = setup()
    const made = await work.create(repo, 'squashed')
    writeFileSync(path.join(made.path, 'b.txt'), 'b\n')
    git(made.path, 'add', '.')
    git(made.path, 'commit', '-q', '-m', 'one')
    writeFileSync(path.join(made.path, 'c.txt'), 'c\n')
    git(made.path, 'add', '.')
    git(made.path, 'commit', '-q', '-m', 'two')
    expect(await item('squashed')).toMatchObject({ state: 'pending-merge', ahead: 2 })
    git(repo, 'merge', '-q', '--squash', 'squashed')
    git(repo, 'commit', '-q', '-m', 'squashed in')
    expect(await item('squashed')).toMatchObject({ state: 'ready', ahead: 0 })
    await work.cleanup(made.key, false)
    expect(git(repo, 'branch', '--list', 'squashed')).toBe('')
  })

  it('removes unmerged work only when told to', async () => {
    const { repo, work } = setup()
    const made = await work.create(repo, 'throwaway')
    writeFileSync(path.join(made.path, 'b.txt'), 'b\n')
    git(made.path, 'add', '.')
    git(made.path, 'commit', '-q', '-m', 'one')
    writeFileSync(path.join(made.path, 'c.txt'), 'c\n')
    const plan = await work.cleanupPlan(made.key)
    expect(plan.blocked).toBeNull()
    expect(plan.losses).toEqual(['1 uncommitted file will be lost.', '1 commit on throwaway is not in main and will be lost.'])
    await expect(work.cleanup(made.key, false)).rejects.toThrow(/will be lost/)
    expect(existsSync(made.path)).toBe(true)
    await work.cleanup(made.key, true)
    expect(existsSync(made.path)).toBe(false)
    expect(git(repo, 'branch', '--list', 'throwaway')).toBe('')
  })

  it('leaves a worktree alone while an agent works in it', async () => {
    const { repo, work, item, sessions } = setup()
    const made = await work.create(repo, 'busy')
    sessions.push({ homeDir: made.path, status: 'busy' })
    expect(await item('busy')).toMatchObject({ state: 'working', sessionOpen: true })
    expect((await work.cleanupPlan(made.key)).blocked).toMatch(/agent is working/)
    await expect(work.cleanup(made.key, true)).rejects.toThrow(/agent is working/)
    await expect(work.commit(made.key, 'claude')).rejects.toThrow(/agent is working/)
    expect(existsSync(made.path)).toBe(true)
  })

  it('cleans up after a folder that was deleted by hand', async () => {
    const { repo, work, item } = setup()
    const made = await work.create(repo, 'vanished')
    rmSync(made.path, { recursive: true, force: true })
    expect((await item('vanished'))?.state).toBe('orphaned')
    await work.cleanup(made.key, false)
    expect(await item('vanished')).toBeUndefined()
    expect(git(repo, 'branch', '--list', 'vanished')).toBe('')
  })

  it('pushes to the remote and counts what is left to push', async () => {
    const { root, repo, work, item, finished } = setup()
    const remote = path.join(root, 'remote.git')
    git(root, 'init', '-q', '--bare', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    const made = await work.create(repo, 'pushed')
    writeFileSync(path.join(made.path, 'b.txt'), 'b\n')
    git(made.path, 'add', '.')
    git(made.path, 'commit', '-q', '-m', 'one')
    expect(await item('pushed')).toMatchObject({ state: 'pending-merge', toPush: null, hasRemote: true })
    const done = finished()
    await work.push(made.key)
    expect(await done).toMatchObject({ kind: 'push', status: 'ok' })
    expect(await item('pushed')).toMatchObject({ state: 'pending-merge', toPush: 0 })
    expect(readFileSync(work.journalFile, 'utf8')).toContain('"action":"push"')
  })
})

describe("work in the repo's own folder", () => {
  it('is listed while there is something to commit, and never removed', async () => {
    const { repo, work, item, finished } = setup()
    expect((await work.overview()).items).toEqual([])
    writeFileSync(path.join(repo, 'b.txt'), 'b\n')
    const own = await item('repo')
    expect(own).toMatchObject({ root: true, branch: 'main', base: null, state: 'uncommitted', changed: 1, ahead: 0 })
    expect((await work.cleanupPlan(own!.key)).blocked).toMatch(/repo's own folder/)
    await expect(work.cleanup(own!.key, true)).rejects.toThrow(/repo's own folder/)

    const done = finished()
    await work.commit(own!.key, 'claude')
    expect(await done).toMatchObject({ kind: 'commit', status: 'ok' })
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('by the agent')
    // Nothing left to do, and no remote to push to.
    expect(await item('repo')).toBeUndefined()
    expect(existsSync(path.join(repo, 'b.txt'))).toBe(true)
    expect(work.readJournal().map((e) => [e.action, e.worktree, e.branch, e.ok])).toEqual([['commit', 'repo', 'main', true]])
  })

  it('stays listed until its commits are pushed', async () => {
    const { root, repo, work, item, finished } = setup()
    const remote = path.join(root, 'remote.git')
    git(root, 'init', '-q', '--bare', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    expect(await item('repo')).toBeUndefined()
    writeFileSync(path.join(repo, 'b.txt'), 'b\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'one')
    const own = await item('repo')
    expect(own).toMatchObject({ root: true, state: 'unpushed', toPush: 1, hasRemote: true })
    const done = finished()
    await work.push(own!.key)
    expect(await done).toMatchObject({ kind: 'push', status: 'ok' })
    expect(await item('repo')).toBeUndefined()
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('one')
  })

  it('merges a branch that is checked out there into the default branch', async () => {
    const { repo, work, item, finished } = setup()
    git(repo, 'checkout', '-q', '-b', 'feat')
    // A branch with nothing of its own is not work yet.
    expect(await item('repo')).toBeUndefined()
    writeFileSync(path.join(repo, 'b.txt'), 'b\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'one')
    const own = await item('repo')
    expect(own).toMatchObject({ root: true, branch: 'feat', base: 'main', state: 'pending-merge', ahead: 1 })
    const done = finished()
    await work.merge(own!.key)
    expect((await done).status).toBe('ok')
    expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('one')
    expect(git(repo, 'branch', '--show-current')).toBe('feat')
    expect(await item('repo')).toBeUndefined()
  })

  it('takes the branch it was made from as the base, not the default branch', async () => {
    const { repo, work, item } = setup()
    git(repo, 'checkout', '-q', '-b', 'develop')
    writeFileSync(path.join(repo, 'd.txt'), 'd\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'on develop')
    // Made with checkout -b, so only the checkout says where from.
    git(repo, 'checkout', '-q', '-b', 'feat')
    writeFileSync(path.join(repo, 'b.txt'), 'b\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'one')
    expect(await item('repo')).toMatchObject({ root: true, branch: 'feat', base: 'develop', state: 'pending-merge', ahead: 1 })
    // A worktree that was not made here: the name it was given is on record.
    const dir = path.join(repo, '.claude', 'worktrees', 'by-hand')
    git(repo, 'worktree', 'add', '-q', '-b', 'by-hand', dir, 'develop')
    expect(await item('by-hand')).toMatchObject({ root: false, base: 'develop' })
  })

  it('does not count a session in a worktree as a session in the repo folder', async () => {
    const { repo, work, item, sessions } = setup()
    const made = await work.create(repo, 'busy')
    writeFileSync(path.join(repo, 'b.txt'), 'b\n')
    sessions.push({ homeDir: made.path, status: 'busy' })
    expect(await item('busy')).toMatchObject({ state: 'working', sessionOpen: true })
    expect(await item('repo')).toMatchObject({ root: true, state: 'uncommitted', sessionOpen: false })
    sessions.push({ homeDir: repo, status: 'busy' })
    expect(await item('repo')).toMatchObject({ state: 'working', sessionOpen: true })
  })
})

describe('pull requests', () => {
  const withRemote = (pushMain = true) => {
    const s = setup()
    const remote = path.join(s.root, 'remote.git')
    git(s.root, 'init', '-q', '--bare', remote)
    git(s.repo, 'remote', 'add', 'origin', remote)
    if (pushMain) git(s.repo, 'push', '-q', '-u', 'origin', 'main')
    return { ...s, remote }
  }
  const commitIn = (dir: string) => {
    writeFileSync(path.join(dir, 'b.txt'), 'b\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'one')
  }

  it('finds the link in what the GitHub CLI says', () => {
    expect(prInText('Creating pull request for fix into main in o/r\n\nhttps://github.com/o/r/pull/12\n')).toEqual({ number: 12, url: 'https://github.com/o/r/pull/12' })
    expect(prInText('a pull request for branch "fix" into branch "main" already exists:\nhttps://github.com/o/r/pull/3')).toEqual({ number: 3, url: 'https://github.com/o/r/pull/3' })
    expect(prInText('remote: Create a pull request by visiting https://github.com/o/r/pull/new/fix')).toBeNull()
    expect(prInText('')).toBeNull()
  })

  it('pushes the branch and opens one into the base', async () => {
    const { repo, remote, work, item, finished } = withRemote()
    const made = await work.create(repo, 'fix')
    await expect(work.prPlan(made.key)).rejects.toThrow(/no commits/)
    writeFileSync(path.join(made.path, 'b.txt'), 'b\n')
    await expect(work.prPlan(made.key)).rejects.toThrow(/uncommitted/)
    git(made.path, 'add', '.')
    git(made.path, 'commit', '-q', '-m', 'one')
    expect(await work.prPlan(made.key)).toMatchObject({ base: 'main', remote: 'origin', push: true })
    expect((await item('fix'))?.pr).toBeNull()

    const done = finished()
    await work.pr(made.key)
    const run = await done
    expect(run).toMatchObject({ kind: 'pr', status: 'ok' })
    expect(run.text).toContain('$ git push -u origin fix')
    expect(run.text).toContain('https://github.com/o/r/pull/8')
    expect(git(remote, 'log', '-1', '--format=%s', 'fix')).toBe('one')
    expect(await item('fix')).toMatchObject({ state: 'pending-merge', toPush: 0, pr: { number: 8, url: 'https://github.com/o/r/pull/8' } })
    expect(work.readJournal()[0]).toMatchObject({ action: 'pr', worktree: 'fix', base: 'main', ok: true, detail: 'into main', url: 'https://github.com/o/r/pull/8' })
    const log = readFileSync(work.log.file, 'utf8')
    expect(log).toMatch(/===== \S+  Open a pull request for fix into main \(repo\)/)
    expect(log).toMatch(/pr create --base main --head fix --fill\nhttps:\/\/github\.com\/o\/r\/pull\/8\s*\n\[exit 0/)
    // Pushed already: the next one would not push again.
    expect((await work.prPlan(made.key)).push).toBe(false)
  })

  it('needs the base branch on the remote', async () => {
    const { repo, work } = withRemote(false)
    const made = await work.create(repo, 'fix')
    commitIn(made.path)
    await expect(work.prPlan(made.key)).rejects.toThrow(/main is not on origin/)
  })

  it('needs a remote', async () => {
    const { repo, work } = setup()
    const made = await work.create(repo, 'fix')
    commitIn(made.path)
    await expect(work.prPlan(made.key)).rejects.toThrow(/no remote/)
  })

  it('reads the open pull requests on a refresh', async () => {
    const { repo, work } = withRemote()
    const listed = await work.create(repo, 'listed')
    commitIn(listed.path)
    const other = await work.create(repo, 'other')
    expect((await work.overview()).items.map((i) => i.pr)).toEqual([null, null])
    const ov = await work.overview({ fetch: true })
    expect(ov.gh).toBe(true)
    expect(ov.items.find((i) => i.key === listed.key)?.pr).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7' })
    expect(ov.items.find((i) => i.key === other.key)?.pr).toBeNull()
    expect(readFileSync(work.log.file, 'utf8')).toContain('pr list --state open')
  })
})

describe('what a new worktree brings along', () => {
  /** A repo with ignored .env files, one tracked example, and installed packages in the root and in a workspace. */
  function withPackages() {
    const t = setup()
    const { repo } = t
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env*\n!.env.example\n')
    writeFileSync(path.join(repo, 'package.json'), '{ "name": "demo", "version": "1.0.0", "private": true }\n')
    writeFileSync(path.join(repo, '.env.example'), 'KEY=\n')
    mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true })
    writeFileSync(path.join(repo, 'apps', 'web', 'package.json'), '{ "name": "web", "version": "1.0.0", "private": true }\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'packages')
    writeFileSync(path.join(repo, '.env'), 'KEY=secret\n')
    writeFileSync(path.join(repo, 'apps', 'web', '.env.local'), 'WEB=1\n')
    for (const dir of ['', path.join('apps', 'web')]) {
      mkdirSync(path.join(repo, dir, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(path.join(repo, dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    }
    // A package's own .env inside node_modules is not the repo's.
    writeFileSync(path.join(repo, 'node_modules', 'pkg', '.env'), 'X=1\n')
    return t
  }

  it('finds the .env files, the node_modules folders and the install command', async () => {
    const { repo, work } = withPackages()
    expect(await work.setupInfo(repo)).toEqual({ envFiles: ['.env', 'apps/web/.env.local'], nodeModules: ['', 'apps/web'], install: 'npm install' })
    writeFileSync(path.join(repo, 'pnpm-lock.yaml'), '')
    expect(installCommand(repo)).toBe('pnpm install')
    expect(installCommand(path.join(repo, 'apps'))).toBeNull()
  })

  it('copies the .env files and links node_modules, and cleanup leaves the repo its packages', async () => {
    const { repo, work, item } = withPackages()
    const made = await work.create(repo, 'linked', { copyEnv: true, deps: 'link' })
    expect(readFileSync(path.join(made.path, '.env'), 'utf8')).toBe('KEY=secret\n')
    expect(readFileSync(path.join(made.path, 'apps', 'web', '.env.local'), 'utf8')).toBe('WEB=1\n')
    expect(readFileSync(path.join(made.path, 'node_modules', 'pkg', 'index.js'), 'utf8')).toContain('module.exports')
    expect(existsSync(path.join(made.path, 'apps', 'web', 'node_modules', 'pkg', 'index.js'))).toBe(true)
    // Neither the copies nor the links count as work to commit.
    expect(made).toMatchObject({ state: 'new', changed: 0 })
    expect((await work.overview()).setup).toEqual({ copyEnv: true, deps: 'link' })
    expect(work.readJournal()[0]).toMatchObject({ action: 'create', detail: 'copied 2 .env files, linked node_modules' })
    const log = readFileSync(work.log.file, 'utf8')
    expect(log).toMatch(/\[copied apps\/web\/\.env\.local from /)
    expect(log).toMatch(/\[linked .*linked.node_modules to .*repo.node_modules\]/)

    await work.cleanup(made.key, false)
    expect(existsSync(made.path)).toBe(false)
    // Git deletes through a link, so the links must be gone before it removes the folder.
    expect(existsSync(path.join(repo, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    expect(existsSync(path.join(repo, 'apps', 'web', 'node_modules', 'pkg', 'index.js'))).toBe(true)
    expect(readFileSync(work.log.file, 'utf8')).toMatch(/\[removed the link .*node_modules\]\n[^]*worktree remove/)
    expect(await item('linked')).toBeUndefined()
  })

  it('brings nothing along unless asked', async () => {
    const { repo, work } = withPackages()
    const made = await work.create(repo, 'bare')
    expect(existsSync(path.join(made.path, '.env'))).toBe(false)
    expect(existsSync(path.join(made.path, '.env.example'))).toBe(true)
    expect(existsSync(path.join(made.path, 'node_modules'))).toBe(false)
  })

  it('removes only links named node_modules, and does not look inside real ones', () => {
    const root = tmpDir()
    const target = path.join(root, 'target')
    mkdirSync(path.join(target, 'pkg'), { recursive: true })
    mkdirSync(path.join(root, 'wt', 'a', 'node_modules', 'inner'), { recursive: true })
    mkdirSync(path.join(root, 'wt', 'b'), { recursive: true })
    symlinkSync(target, path.join(root, 'wt', 'b', 'node_modules'), 'junction')
    symlinkSync(target, path.join(root, 'wt', 'a', 'node_modules', 'inner', 'node_modules'), 'junction')
    expect(unlinkNodeModules(path.join(root, 'wt'))).toEqual([path.join(root, 'wt', 'b', 'node_modules')])
    expect(existsSync(path.join(target, 'pkg'))).toBe(true)
    expect(existsSync(path.join(root, 'wt', 'a', 'node_modules', 'inner', 'node_modules'))).toBe(true)
  })

  it('runs the install in the worktree and logs it', async () => {
    const { repo, work, finished } = withPackages()
    const made = await work.create(repo, 'installed')
    const done = finished()
    await work.install(made.key)
    const run = await done
    expect(run).toMatchObject({ kind: 'install', status: 'ok', title: 'npm install in installed' })
    expect(run.text.startsWith('$ npm install\n')).toBe(true)
    expect(readFileSync(work.log.file, 'utf8')).toMatch(/installed> npm install\n[^]*?\[exit 0 · \d+ ms\]/)
    expect(work.readJournal()[0]).toMatchObject({ action: 'install', ok: true, detail: 'npm install' })
  }, 120_000)
})

describe('merging into a branch of choice', () => {
  /** A worktree with one commit, and a dev branch next to main that no folder has checked out. */
  async function withDev(devMovesOn: 'no' | 'other file' | 'same file') {
    const t = setup()
    const { repo, work } = t
    git(repo, 'branch', 'dev')
    if (devMovesOn !== 'no') {
      git(repo, 'checkout', '-q', 'dev')
      writeFileSync(path.join(repo, devMovesOn === 'same file' ? 'a.txt' : 'dev.txt'), 'dev\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-q', '-m', 'on dev')
      git(repo, 'checkout', '-q', 'main')
    }
    const made = await work.create(repo, 'feature')
    writeFileSync(path.join(made.path, 'a.txt'), 'feature\n')
    git(made.path, 'commit', '-q', '-am', 'feature')
    const merge = async (into?: string) => {
      const done = t.finished()
      await work.merge(made.key, into)
      return done
    }
    const worktrees = () => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length
    return { ...t, made, merge, worktrees }
  }

  it('offers the local branches', async () => {
    const { work, made } = await withDev('no')
    expect((await work.overview()).repos[0].branches.sort()).toEqual(['dev', 'feature', 'main'])
    await expect(work.mergePlan(made.key, 'nope')).rejects.toThrow(/no local branch named nope/)
    await expect(work.mergePlan(made.key, 'feature')).rejects.toThrow(/into itself/)
    expect(await work.mergePlan(made.key)).toMatchObject({ into: 'main' })
    expect(await work.mergePlan(made.key, 'dev')).toMatchObject({ into: 'dev', target: null })
  })

  it('moves a branch forward that no folder has checked out', async () => {
    const { repo, work, item, merge } = await withDev('no')
    expect(await merge('dev')).toMatchObject({ status: 'ok', title: 'Merge feature into dev' })
    expect(git(repo, 'log', '-1', '--format=%s', 'dev')).toBe('feature')
    // It is still not in main, the branch it came from.
    expect(await item('feature')).toMatchObject({ state: 'pending-merge', base: 'main' })
    expect(git(repo, 'show', 'main:a.txt')).toBe('a')
    expect(work.readJournal()[0]).toMatchObject({ action: 'merge', ok: true, detail: 'into dev' })
  })

  it('merges in a temporary checkout when that branch has moved on', async () => {
    const { repo, work, merge, worktrees } = await withDev('other file')
    const run = await merge('dev')
    expect(run.status).toBe('ok')
    expect(run.text).toContain('Merging in a temporary checkout')
    expect(git(repo, 'show', 'dev:a.txt')).toBe('feature')
    expect(git(repo, 'show', 'dev:dev.txt')).toBe('dev')
    expect(git(repo, 'log', '-1', '--format=%p', 'dev').split(' ')).toHaveLength(2)
    // The checkout is gone again, and the repo's own folder was not touched.
    expect(worktrees()).toBe(2)
    expect(git(repo, 'branch', '--show-current')).toBe('main')
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(readFileSync(work.log.file, 'utf8')).toMatch(/> git worktree add .*vsm-merge-\S+ dev\n[^]*> git merge --no-edit feature\n[^]*worktree remove --force/)
  })

  it('undoes a merge with conflicts and leaves the branch as it was', async () => {
    const { repo, work, merge, worktrees } = await withDev('same file')
    const before = git(repo, 'rev-parse', 'dev')
    const run = await merge('dev')
    expect(run.status).toBe('failed')
    expect(run.text).toContain('has conflicts, so it was undone')
    expect(git(repo, 'rev-parse', 'dev')).toBe(before)
    expect(worktrees()).toBe(2)
    expect(work.readJournal()[0]).toMatchObject({ action: 'merge', ok: false, detail: 'into dev' })
  })
})
