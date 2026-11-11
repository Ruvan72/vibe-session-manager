// The Work tab: start a worktree, let an agent commit it, push, merge and clean up, with every
// worktree's standing in a list and the exact commands that were run one click away.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DebugActions } from '../../shared/api.ts'
import type { WorkAgent, WorkCreateOptions, WorkItem, WorkJournalEntry, WorkLogTail, WorkOverview, WorkResult, WorkRun, WorkSetupInfo, WorkState } from '../../shared/types.ts'
import { AgentIcon, LightIcon, RepoFilter, TreeIcon } from './components.tsx'
import { absTime, relTime, WORK_STATE_LABEL, workDetail, workJournalText } from './view.ts'

const api = window.api

const AGENT_NAME: Record<WorkAgent, string> = { claude: 'Claude', codex: 'Codex' }
const NO_SETUP: WorkSetupInfo = { envFiles: [], nodeModules: [], install: null }
const RUN_STATUS: Record<WorkRun['status'], string> = { running: 'Running…', ok: 'Done', failed: 'Failed', stopped: 'Stopped' }
const PICK = '\u0000pick'
const REFRESH_MS = 20_000

/** A shape per state as well as a colour, like the session lights. */
export function WorkStateIcon({ state }: { state: WorkState }) {
  if (state === 'working') return <LightIcon light="green" guess={false} title={WORK_STATE_LABEL.working} />
  return (
    <span className={`work-icon state-${state}`} title={WORK_STATE_LABEL[state]} aria-label={WORK_STATE_LABEL[state]}>
      <svg viewBox="0 0 16 16" aria-hidden>
        {state === 'uncommitted' && <path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2z" />}
        {state === 'new' && (
          <>
            <circle cx="8" cy="8" r="6.3" />
            <path d="M8 5.2v5.6M5.2 8h5.6" />
          </>
        )}
        {state === 'pending-merge' && (
          <>
            <circle cx="4.5" cy="3.5" r="1.7" />
            <circle cx="4.5" cy="12.5" r="1.7" />
            <circle cx="11.5" cy="8" r="1.7" />
            <path d="M4.5 5.2v5.6M4.5 5.6c0 2 1.8 2.4 5.3 2.4" />
          </>
        )}
        {state === 'unpushed' && <path d="M8 13V3.5M3.8 7.6L8 3.4l4.2 4.2" />}
        {state === 'ready' && (
          <>
            <circle cx="8" cy="8" r="7" className="disc" />
            <path d="M5 8.2l2 2 4-4.2" className="inv" />
          </>
        )}
        {state === 'orphaned' && (
          <>
            <path d="M1.8 12.5v-8h4l1.4 1.6h7v6.4z" strokeDasharray="2 1.6" />
            <path d="M6.3 8l3.4 3M9.7 8l-3.4 3" />
          </>
        )}
      </svg>
    </span>
  )
}

/** The branches a worktree's branch can be merged into. Closes on a click elsewhere and on Esc. */
function BranchMenu({ branches, base, onPick, onClose }: { branches: string[]; base: string | null; onPick(branch: string): void; onClose(): void }) {
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, button')?.focus()
    const onDown = (e: MouseEvent) => {
      // The button that opened the menu closes it itself.
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const q = query.trim().toLowerCase()
  const shown = q ? branches.filter((b) => b.toLowerCase().includes(q)) : branches
  return (
    <div
      className="label-menu work-menu"
      role="menu"
      aria-label="Merge into"
      ref={ref}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
    >
      {branches.length > 8 && <input className="repo-search" value={query} placeholder="Find branch…" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />}
      <ul>
        {shown.map((b) => (
          <li key={b}>
            <button role="menuitem" title={`Merge into ${b}`} onClick={() => onPick(b)}>
              <span className="name">{b}</span>
              {b === base && <span className="count">came from</span>}
            </button>
          </li>
        ))}
        {!shown.length && <li className="none">No branches match.</li>}
      </ul>
    </div>
  )
}

interface Props {
  active: boolean
  debug: DebugActions | null
  now: number
  onMessage(m: string): void
}

export function WorkView({ active, debug, now, onMessage }: Props) {
  const [ov, setOv] = useState<WorkOverview | null>(null)
  const [run, setRun] = useState<WorkRun | null>(null)
  const [creating, setCreating] = useState(false)
  const [repo, setRepo] = useState<string | null>(null)
  const [name, setName] = useState('')
  /** What to bring along; null until the user changes it, and then the last used options no longer apply. */
  const [chosen, setChosen] = useState<WorkCreateOptions | null>(null)
  const [setup, setSetup] = useState<WorkSetupInfo>(NO_SETUP)
  /** What is being waited for: 'create', 'refresh', or the key of a worktree. */
  const [busy, setBusy] = useState<string | null>(null)
  const [panel, setPanel] = useState<'history' | 'log' | null>(null)
  const [log, setLog] = useState<WorkLogTail | null>(null)
  /** The part of the command log that is shown: one worktree's, or one action of the history. Null is all of it. */
  const [scope, setScope] = useState<{ key?: string; id?: string; label: string } | null>(null)
  const [copied, setCopied] = useState(false)
  /** The merge menu that is open: where it is ('row' or 'run') and the worktree's key. */
  const [mergeMenu, setMergeMenu] = useState<string | null>(null)
  /** Paths of the repos to show; none = all. */
  const [shown, setShown] = useState<string[]>([])
  const runRef = useRef<HTMLPreElement>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (fetch = false) => {
    const o = await api.getWork({ fetch })
    setOv(o)
    setRun(o.run)
  }, [])

  useEffect(() => {
    const offs = [api.onWorkRun(setRun), api.onWorkChanged(() => void load())]
    return () => offs.forEach((off) => off())
  }, [load])

  // Other programs change worktrees too, so the list is read again while it is on screen.
  useEffect(() => {
    if (!active) return
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [active, load])

  useEffect(() => {
    if (debug?.workCreate) setCreating(true)
    if (debug?.workLog) setPanel('log')
  }, [debug])

  useEffect(() => {
    if (creating) nameRef.current?.focus()
  }, [creating])

  // The log is read when its panel opens, when another part of it is asked for, and whenever something was run.
  useEffect(() => {
    if (panel !== 'log' || !active) return
    let cancelled = false
    void api.readWorkLog(scope ? { key: scope.key, id: scope.id } : undefined).then((l) => !cancelled && setLog(l))
    return () => {
      cancelled = true
    }
  }, [panel, active, ov, run?.status, scope])

  useLayoutEffect(() => {
    runRef.current?.scrollTo(0, runRef.current.scrollHeight)
  }, [run?.text])

  useLayoutEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [log?.text])

  const repos = ov?.repos ?? []
  // A new worktree goes in the repo that was picked in the form, else the one the list is filtered to, else the last one used.
  const filtered = shown.length === 1 && repos.some((r) => r.path === shown[0]) ? shown[0] : null
  const repoPath = repo && repos.some((r) => r.path === repo) ? repo : (filtered ?? ov?.lastRepo ?? repos[0]?.path ?? null)
  const picked = repos.find((r) => r.path === repoPath) ?? null
  const running = run?.status === 'running'

  // What the picked repo has to bring along, read when the form opens and when another repo is picked.
  useEffect(() => {
    if (!creating || !repoPath) return setSetup(NO_SETUP)
    let cancelled = false
    void api.getWorkSetup(repoPath).then((s) => !cancelled && setSetup(s))
    return () => {
      cancelled = true
    }
  }, [creating, repoPath])

  const wanted = chosen ?? ov?.setup ?? { copyEnv: true, deps: 'none' as const }
  // An option the repo has nothing for falls back to leaving it out.
  const opts: WorkCreateOptions = {
    copyEnv: wanted.copyEnv && setup.envFiles.length > 0,
    deps: (wanted.deps === 'link' && !setup.nodeModules.length) || (wanted.deps === 'install' && !setup.install) ? 'none' : wanted.deps
  }
  const agent = ov?.agent ?? null

  /** Runs an action, shows what it says, and reads the list again. */
  const act = async (key: string, fn: () => Promise<WorkResult>): Promise<WorkResult> => {
    setBusy(key)
    try {
      const res = await fn()
      if (res.message) onMessage(res.message)
      await load()
      return res
    } finally {
      setBusy(null)
    }
  }

  const create = async () => {
    if (!repoPath || !name.trim() || busy) return
    const res = await act('create', () => api.createWork(repoPath, name, opts))
    if (res.ok) {
      setName('')
      setCreating(false)
    }
  }

  const pickRepo = async () => {
    const res = await api.pickWorkRepo()
    if (!res) return
    if (!res.ok) return onMessage(res.message ?? 'That folder cannot be used.')
    await load()
    setRepo(res.path)
  }

  const setAgent = (a: WorkAgent) => {
    setOv((o) => (o ? { ...o, agent: a } : o))
    void api.setWorkAgent(a)
  }

  const copyLog = () => {
    if (!log) return
    void api.copyText(log.text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const showLog = (s: { key?: string; id?: string; label: string }) => {
    setScope(s)
    setPanel('log')
  }

  const actions = (i: WorkItem, withOpen: boolean) => {
    const wait = busy === i.key
    const blocked = running ? 'Wait for what is running, or stop it' : undefined
    const mergeable = i.state === 'pending-merge' && !!i.branch && !!i.base
    // Any other local branch can be merged into, the base first.
    const all = repos.find((r) => r.path === i.repoPath)?.branches ?? []
    const targets = i.branch ? [...(i.base && all.includes(i.base) ? [i.base] : []), ...all.filter((b) => b !== i.branch && b !== i.base)] : []
    // The repo's own folder is only merged when it is on a branch with a base to go back into.
    const canMerge = targets.length > 0 && (!i.root || !!i.base) && (i.state === 'pending-merge' || i.state === 'ready' || i.state === 'uncommitted')
    const canPush = (mergeable || i.state === 'unpushed') && !!i.branch && i.hasRemote && i.toPush !== 0
    const canPr = mergeable && i.hasRemote
    const menuId = `${withOpen ? 'row' : 'run'}:${i.key}`
    const noMerge = i.state === 'uncommitted' ? 'Commit the work first' : blocked
    const logOpen = panel === 'log' && scope?.key === i.key
    const mergeInto = (b: string) => {
      setMergeMenu(null)
      void act(i.key, () => api.mergeWork(i.key, b))
    }
    return (
      <div className="actions work-actions">
        {withOpen && i.state !== 'orphaned' && (
          <button title={`Open ${i.root ? "the repo's folder" : 'this worktree'} in the editor (double-click)`} onClick={() => void act(i.key, () => api.openWork(i.key))}>
            Open
          </button>
        )}
        {i.state === 'uncommitted' && (
          <button
            className="primary"
            disabled={!agent || running || wait}
            title={!agent ? 'Needs the claude or codex command on this machine' : (blocked ?? `${AGENT_NAME[agent]} looks at the changes, stages them and commits. It is told not to push or change files.`)}
            onClick={() => agent && void act(i.key, () => api.commitWork(i.key, agent))}
          >
            Commit work
          </button>
        )}
        {canPush && (
          <button className={i.state === 'unpushed' ? 'primary' : ''} disabled={running || wait} title={blocked ?? `git push -u, so ${i.branch} is on the remote`} onClick={() => void act(i.key, () => api.pushWork(i.key))}>
            Push
          </button>
        )}
        {canPr &&
          (i.pr ? (
            <button title={`Open the pull request in the browser\n${i.pr.url}`} onClick={() => void api.openLink(i.pr!.url)}>
              Open PR #{i.pr.number}
            </button>
          ) : (
            <button
              disabled={!ov?.gh || running || wait}
              title={!ov?.gh ? 'Needs the GitHub CLI (gh) on this machine' : (blocked ?? `Asks first, then ${i.toPush !== 0 ? 'pushes and ' : ''}opens a pull request for ${i.branch} into ${i.base} with the GitHub CLI`)}
              onClick={() => void act(i.key, () => api.prWork(i.key))}
            >
              Create PR
            </button>
          ))}
        {canMerge && (
          <div className="work-merge">
            {mergeable && targets[0] === i.base ? (
              <>
                <button className="main" disabled={running || wait} title={noMerge ?? `Asks first, then merges ${i.branch} into ${i.base}, the branch it came from`} onClick={() => mergeInto(i.base!)}>
                  Merge into {i.base}
                </button>
                {targets.length > 1 && (
                  <button className="more" disabled={running || wait} aria-haspopup="true" aria-expanded={mergeMenu === menuId} aria-label="Merge into another branch" title="Merge into another branch" onClick={() => setMergeMenu((m) => (m === menuId ? null : menuId))}>
                    <svg viewBox="0 0 16 16" aria-hidden><path d="M4 6l4 4 4-4" /></svg>
                  </button>
                )}
              </>
            ) : (
              <button disabled={running || wait || i.state === 'uncommitted'} aria-haspopup="true" aria-expanded={mergeMenu === menuId} title={noMerge ?? `Pick the branch to merge ${i.branch} into`} onClick={() => setMergeMenu((m) => (m === menuId ? null : menuId))}>
                Merge into…
              </button>
            )}
            {mergeMenu === menuId && <BranchMenu branches={targets} base={i.base} onPick={mergeInto} onClose={() => setMergeMenu(null)} />}
          </div>
        )}
        {i.state !== 'working' && !i.root && (
          <button
            className={i.state === 'ready' ? 'primary' : ''}
            disabled={wait || (running && run?.key === i.key)}
            title={
              i.state === 'ready' || i.state === 'new'
                ? 'Asks first, then removes the worktree and deletes its branch'
                : i.state === 'orphaned'
                  ? 'Asks first, then removes what git still has of this worktree'
                  : 'This worktree has work that is not merged. Asks first, and tells what would be lost.'
            }
            onClick={() => void act(i.key, () => api.cleanupWork(i.key))}
          >
            Clean up
          </button>
        )}
        {withOpen && (
          <button
            aria-pressed={logOpen}
            title="Every command this tab ran for it, with everything they printed"
            onClick={() => (logOpen ? setPanel(null) : showLog({ key: i.key, label: i.root ? `${i.repo} (repo folder)` : i.name }))}
          >
            Log
          </button>
        )}
      </div>
    )
  }

  const items = ov?.items ?? []
  const allGroups = repos.map((r) => ({ repo: r, items: items.filter((i) => i.repoPath === r.path) })).filter((g) => g.items.length)
  const repoOptions = allGroups.map((g) => ({ key: g.repo.path, label: g.repo.name, count: g.items.length })).sort((a, b) => a.label.localeCompare(b.label))
  // A repo whose last worktree was cleaned up drops out of the filter with it.
  const shownRepos = shown.filter((p) => allGroups.some((g) => g.repo.path === p))
  const groups = shownRepos.length ? allGroups.filter((g) => shownRepos.includes(g.repo.path)) : allGroups
  const runItem = run ? items.find((i) => i.key === run.key) : undefined

  return (
    <div className="work" hidden={!active}>
      <div className="work-bar">
        <div className="actions">
          <button className={creating ? '' : 'primary'} aria-expanded={creating} onClick={() => setCreating((c) => !c)}>
            {creating ? 'Cancel' : 'Create worktree'}
          </button>
        </div>
        {repoOptions.length > 1 && <RepoFilter options={repoOptions} selected={shownRepos} onChange={setShown} />}
        <span className="spacer" />
        {ov && ov.agents.length === 0 && <span className="work-note" title="Commit work runs the claude or codex command, and neither was found on this machine.">No agent found</span>}
        {ov && ov.agents.length > 0 && (
          <div className="segmented" title="The agent that does Commit work">
            {ov.agents.map((a) => (
              <button key={a} className={agent === a ? 'on' : ''} aria-pressed={agent === a} onClick={() => setAgent(a)}>
                <AgentIcon agent={a} />
                {AGENT_NAME[a]}
              </button>
            ))}
          </div>
        )}
        <button
          className={`icon-btn ${busy === 'refresh' ? 'turning' : ''}`}
          title="Read again, after asking the remotes (git fetch), so merges done elsewhere show"
          disabled={busy === 'refresh'}
          onClick={() => {
            setBusy('refresh')
            void load(true).finally(() => setBusy(null))
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8M13.4 2.2v2.6h-2.6" /></svg>
        </button>
      </div>

      {creating && (
        <form
          className="work-create"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.stopPropagation()
            setCreating(false)
          }}
        >
          <label>
            <span>Repo</span>
            <select value={repoPath ?? ''} onChange={(e) => (e.target.value === PICK ? void pickRepo() : setRepo(e.target.value))}>
              {!repos.length && <option value="">No repos yet</option>}
              {repos.map((r) => (
                <option key={r.path} value={r.path} title={r.path}>
                  {r.name}
                </option>
              ))}
              <option value={PICK}>Other folder…</option>
            </select>
          </label>
          <label className="grow">
            <span>Name</span>
            <input ref={nameRef} value={name} placeholder="fix-login" spellCheck={false} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={!repoPath || !name.trim() || busy === 'create'}>
              {busy === 'create' ? 'Creating…' : 'Create'}
            </button>
          </div>
          <div className="work-setup">
            <label
              className={`work-check ${setup.envFiles.length ? '' : 'off'}`}
              title={setup.envFiles.length ? `Copies these to the same places in the worktree:\n${setup.envFiles.join('\n')}` : 'This repo has no .env files that git does not track'}
            >
              <input type="checkbox" checked={opts.copyEnv} disabled={!setup.envFiles.length} onChange={(e) => setChosen({ ...wanted, copyEnv: e.target.checked })} />
              Copy .env files{setup.envFiles.length ? ` (${setup.envFiles.length})` : ''}
            </label>
            <label className="work-deps">
              <span>node_modules</span>
              <select value={opts.deps} onChange={(e) => setChosen({ ...wanted, deps: e.target.value as WorkCreateOptions['deps'] })}>
                <option value="none">Leave out</option>
                <option value="link" disabled={!setup.nodeModules.length}>
                  Link to the repo's{setup.nodeModules.length > 1 ? ` (${setup.nodeModules.length})` : ''}
                </option>
                <option value="install" disabled={!setup.install}>
                  {setup.install ? `Run ${setup.install}` : 'Run npm install'}
                </option>
              </select>
            </label>
          </div>
          <p className="work-hint">
            {picked ? (
              <>
                Makes the folder <span className="mono">{picked.name}/.claude/worktrees/{name.trim() || '<name>'}</span> on a new branch <span className="mono">{name.trim() || '<name>'}</span>
                {picked.branch ? <> from <span className="mono">{picked.branch}</span></> : ' from the current commit'}, then opens it in the editor.
                {opts.deps === 'link' && <> The worktree and the repo then share one node_modules, so an install in either changes both. Remove the worktree with Clean up here: a plain <span className="mono">git worktree remove</span> deletes the repo's node_modules through the link.</>}
              </>
            ) : (
              'Pick the repo to make the worktree in.'
            )}
          </p>
        </form>
      )}

      {run && (
        <section className={`work-run run-${run.status}`} aria-label="Output">
          <header>
            {run.agent && <AgentIcon agent={run.agent} />}
            <strong title={run.title}>{run.title}</strong>
            <span className="work-run-status">{RUN_STATUS[run.status]}</span>
            <span className="spacer" />
            {running ? (
              <div className="actions">
                <button onClick={() => void api.stopWork()}>Stop</button>
              </div>
            ) : (
              <>
                {run.status === 'ok' && runItem && actions(runItem, false)}
                <button className="icon-btn" title="Close the output. It stays in the command log." onClick={() => void api.dismissWorkRun()}>
                  <svg viewBox="0 0 16 16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" /></svg>
                </button>
              </>
            )}
          </header>
          <pre ref={runRef}>{run.text || 'Starting…'}</pre>
        </section>
      )}

      <div className="list work-list">
        <h3 className="work-heading">Work in progress</h3>
        {!ov && <div className="empty">Reading worktrees…</div>}
        {ov && !groups.length && <div className="empty">Nothing in progress. Create a worktree to start a piece of work on its own branch.</div>}
        {shownRepos.length > 0 && allGroups.length > groups.length && (
          <div className="work-filtered">
            {allGroups.length - groups.length === 1 ? '1 other repo has' : `${allGroups.length - groups.length} other repos have`} work in progress.{' '}
            <button className="link" onClick={() => setShown([])}>
              Show all repos
            </button>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.repo.path} className="group">
            <h2 title={g.repo.path}>{g.repo.name}</h2>
            {g.items.map((i) => (
              <div
                key={i.key}
                className={`work-item state-${i.state}`}
                title={i.path}
                onDoubleClick={(e) => {
                  if (!(e.target instanceof HTMLButtonElement) && i.state !== 'orphaned') void act(i.key, () => api.openWork(i.key))
                }}
              >
                <WorkStateIcon state={i.state} />
                <div className="row-main">
                  <div className="row-title">
                    {i.root ? (
                      <>
                        {i.branch ?? 'no branch'}
                        <span className="work-branch" title="Work in the repo's own folder, not in a worktree. It can be committed, pushed and merged here, and the folder is never removed."> · repo folder</span>
                      </>
                    ) : (
                      <>
                        <TreeIcon />
                        {i.name}
                        {i.branch !== i.name && <span className="work-branch"> · {i.branch ?? 'no branch'}</span>}
                      </>
                    )}
                  </div>
                  <div className="row-sub">
                    <span className={`work-state state-${i.state}`}>{WORK_STATE_LABEL[i.state]}</span>
                    <span className="where">{workDetail(i)}</span>
                  </div>
                  {actions(i, true)}
                </div>
                <div className="row-side">{i.lastCommitAt && <time title={`Last commit ${absTime(i.lastCommitAt)}`}>{relTime(i.lastCommitAt, now)}</time>}</div>
              </div>
            ))}
          </section>
        ))}
      </div>

      {panel && (
        <section className="work-panel" aria-label={panel === 'log' ? 'Command log' : 'History'}>
          {panel === 'history' ? (
            <>
              <header>
                <strong>History</strong>
                <span className="work-note">What was done from this tab</span>
                <span className="spacer" />
                <button className="link" onClick={() => void api.showWorkJournal()}>
                  Show file
                </button>
              </header>
              <ul className="work-history">
                {!ov?.journal.length && <li className="none">Nothing yet.</li>}
                {ov?.journal.map((e: WorkJournalEntry, n) => (
                  <li key={n} className={e.ok ? '' : 'failed'} title={e.repoPath}>
                    <time title={new Date(e.at).toLocaleString()}>{absTime(Date.parse(e.at))}</time>
                    <span className="what">
                      {workJournalText(e)}
                      {e.log && (
                        <>
                          {' '}
                          <button className="link" title="The commands this ran, with everything they printed" onClick={() => showLog({ id: e.log, label: workJournalText(e) })}>
                            Log
                          </button>
                        </>
                      )}
                      {e.url && (
                        <>
                          {' '}
                          <button className="link" title={e.url} onClick={() => void api.openLink(e.url!)}>
                            Open
                          </button>
                        </>
                      )}
                    </span>
                    <span className="where">{e.repo}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <header>
                <strong>Command log</strong>
                {scope ? (
                  <span className="work-note">
                    {scope.label}
                    {log?.truncated && ', the latest part'} ·{' '}
                    <button className="link" onClick={() => setScope(null)}>
                      Show all
                    </button>
                  </span>
                ) : (
                  <span className="work-note">{log?.truncated ? 'The latest part; the file has it all' : 'Every command this tab ran, and its output'}</span>
                )}
                <span className="spacer" />
                <button className="link" disabled={!log?.text} onClick={copyLog}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button className="link" disabled={!log?.text} title={log?.file} onClick={() => void api.openWorkLog()}>
                  Open file
                </button>
              </header>
              <pre ref={logRef}>{log?.text || (scope ? `Nothing in the log for ${scope.label}.` : 'Nothing has been run yet.')}</pre>
            </>
          )}
        </section>
      )}

      <div className="work-foot">
        <button className={`chip ${panel === 'history' ? 'on' : ''}`} aria-pressed={panel === 'history'} onClick={() => setPanel((p) => (p === 'history' ? null : 'history'))}>
          History
        </button>
        <button
          className={`chip ${panel === 'log' ? 'on' : ''}`}
          aria-pressed={panel === 'log'}
          title="The exact commands this tab ran, with everything they printed"
          onClick={() => {
            // From one worktree's or one action's part, the button goes to the whole log.
            setPanel(panel === 'log' && !scope ? null : 'log')
            setScope(null)
          }}
        >
          Command log
        </button>
      </div>
    </div>
  )
}
