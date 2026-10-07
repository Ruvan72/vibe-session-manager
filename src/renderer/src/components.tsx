import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SettingsInfo } from '../../shared/api.ts'
import type { Agent, AppSettings, DayFile, HooksStatus, LabelDef, Light, SessionView, Snapshot } from '../../shared/types.ts'
import { LabelMenu } from './labels.tsx'
import { playBlop } from './sound.ts'
import {
  absTime,
  clipToDay,
  clockRange,
  dayCsv,
  dayKey,
  dayLabel,
  dayRows,
  formatDuration,
  groupTimeRows,
  localDayStart,
  shiftDay,
  sumMs,
  type RepoOption
} from './view.ts'

const api = window.api

/** Marks a session that runs in a git worktree. */
export function TreeIcon() {
  return (
    <svg className="tree-icon" viewBox="0 0 16 16" aria-label="Worktree" role="img">
      <title>Worktree</title>
      <path d="M8 .8 4.3 5.6h1.9L3.4 9.4h2.1L2.3 13.3h11.4l-3.2-3.9h2.1L9.8 5.6h1.9z" />
      <rect x="7" y="13" width="2" height="2.6" rx=".4" />
    </svg>
  )
}

const AGENT_NAME: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex' }

// Claude's starburst: ten rays of alternating length around the centre.
const CLAUDE_RAYS = Array.from({ length: 10 }, (_, i) => {
  const a = ((i * 36 - 90) * Math.PI) / 180
  const r = i % 2 ? 5.6 : 6.9
  const p = (d: number) => `${(8 + d * Math.cos(a)).toFixed(2)} ${(8 + d * Math.sin(a)).toFixed(2)}`
  return `M${p(1.3)}L${p(r)}`
}).join('')

/** Which agent a session belongs to: Claude's starburst or Codex's terminal prompt. */
export function AgentIcon({ agent }: { agent: Agent }) {
  return (
    <svg className={`agent-icon agent-${agent}`} viewBox="0 0 16 16" aria-label={AGENT_NAME[agent]} role="img">
      <title>{AGENT_NAME[agent]}</title>
      {agent === 'claude' ? (
        <path d={CLAUDE_RAYS} />
      ) : (
        <>
          <rect x="1" y="1.5" width="14" height="13" rx="3.5" className="bg" />
          <path d="M4.5 5.8 7 8l-2.5 2.2M8.6 10.5h3" className="fg" />
        </>
      )}
    </svg>
  )
}

/** "repo · <tree> worktree" or "repo · branch". */
export function Where({ repo, worktree, branch }: { repo?: string; worktree: string | null; branch: string | null }) {
  return (
    <span className="where">
      {repo}
      {repo && (worktree || branch) && ' · '}
      {worktree ? (
        <>
          <TreeIcon />
          {worktree}
        </>
      ) : (
        (branch ?? (repo ? '' : '—'))
      )}
    </span>
  )
}

/** Colour plus a distinct shape, so the state is readable without colour vision. */
export function LightIcon({ light, guess, title, small, closed }: { light: Light; guess: boolean; title?: string; small?: boolean; closed?: boolean }) {
  const cls = `light light-${light} ${guess ? 'guess' : ''} ${small ? 'small' : ''}`
  return (
    <span className={cls} title={title} aria-label={title}>
      <svg viewBox="0 0 16 16" aria-hidden>
        {light === 'red' &&
          (guess ? (
            <>
              <circle cx="8" cy="8" r="6.5" className="ring" />
              <path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4" className="glyph-stroke" />
              <circle cx="8" cy="11.6" r=".9" className="glyph-fill" />
            </>
          ) : (
            <>
              <circle cx="8" cy="8" r="7" className="disc" />
              <rect x="7.1" y="3.6" width="1.8" height="5.6" rx=".9" className="glyph" />
              <circle cx="8" cy="11.6" r="1.05" className="glyph" />
            </>
          ))}
        {light === 'yellow' && (
          <>
            <circle cx="8" cy="8" r={guess ? 6.5 : 7} className={guess ? 'ring' : 'disc'} />
            <path d="M5 8.2l2 2 4-4.2" className={guess ? 'glyph-stroke' : 'glyph-stroke inv'} />
          </>
        )}
        {light === 'green' &&
          (small ? (
            <>
              <circle cx="8" cy="8" r="7" className="disc" />
              <path d="M6.3 5v6l4.9-3z" className="glyph" />
            </>
          ) : (
            // Working: a smaller disc with an arc turning around it, like the tray icon.
            <>
              <circle cx="8" cy="8" r="7.1" className="track" />
              <circle cx="8" cy="8" r="7.1" className="spin" pathLength={100} />
              <circle cx="8" cy="8" r="5.3" className="disc" />
              <path d="M6.7 5.6v4.8l3.9-2.4z" className="glyph" />
            </>
          ))}
        {light === 'grey' && <circle cx="8" cy="8" r="3.2" className={closed ? 'hollow' : 'dot'} />}
      </svg>
    </span>
  )
}

/** Dropdown with a checkbox per repo. Nothing ticked = all repos. */
export function RepoFilter({ options, selected, onChange, initialOpen }: { options: RepoOption[]; selected: string[]; onChange(repos: string[]): void; initialOpen?: boolean }) {
  const [open, setOpen] = useState(!!initialOpen)
  const [query, setQuery] = useState('')
  const [shift, setShift] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  // Keep the dropdown inside the window: move it left when it would stick out on the right.
  useLayoutEffect(() => {
    const menu = ref.current?.querySelector('.repo-menu')
    if (!open || !menu) return setShift(0)
    const anchor = ref.current!.getBoundingClientRect().left
    setShift(Math.min(0, window.innerWidth - 8 - (anchor + menu.getBoundingClientRect().width)))
  }, [open])

  useEffect(() => {
    if (!open) return
    ref.current?.querySelector('input')?.focus()
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const names = new Map(options.map((o) => [o.key, o.label]))
  const text = !selected.length ? 'All repos' : selected.length === 1 ? (names.get(selected[0]) ?? '1 repo') : `${selected.length} repos`
  const q = query.trim().toLowerCase()
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options
  const toggle = (key: string, on: boolean) => onChange(on ? [...selected, key] : selected.filter((k) => k !== key))

  return (
    <div
      className="repo-filter"
      ref={ref}
      onKeyDown={(e) => {
        // Keys here belong to the dropdown, not to the list's shortcuts.
        if (!open) return
        e.stopPropagation()
        if (e.key === 'Escape') setOpen(false)
      }}
    >
      <button
        className={`chip ${selected.length ? 'on' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        title={selected.length ? selected.map((k) => names.get(k) ?? k).join(', ') : 'Only show some repos'}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="repo-text">{text}</span>
        <svg className="caret" viewBox="0 0 16 16" aria-hidden><path d="M4 6l4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="label-menu repo-menu" role="dialog" aria-label="Repos" style={{ left: shift }}>
          {options.length > 6 && (
            <input className="repo-search" value={query} placeholder="Find repo…" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
          )}
          <ul>
            {shown.map((o) => (
              <li key={o.key}>
                <label title={o.key}>
                  <input type="checkbox" checked={selected.includes(o.key)} onChange={(e) => toggle(o.key, e.target.checked)} />
                  <span className="name">{o.label}</span>
                  <span className="count">{o.count}</span>
                </label>
              </li>
            ))}
            {!shown.length && <li className="none">No repos match.</li>}
          </ul>
          {selected.length > 0 && (
            <button className="link" onClick={() => onChange([])}>
              Show all repos
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Small field over a row's title. Enter keeps the new title, Esc or clicking elsewhere cancels. */
export function TitleEditor({ title, onDone }: { title: string; onDone(title: string | null): void }) {
  const [value, setValue] = useState(title)
  const ref = useRef<HTMLInputElement>(null)
  // Enter unmounts the field, and that can fire blur after the commit.
  const done = useRef(false)
  const finish = (result: string | null) => {
    if (done.current) return
    done.current = true
    onDone(result)
  }

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  return (
    <input
      ref={ref}
      className="title-edit"
      value={value}
      aria-label="Session title"
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        // Keys here belong to the field, not to the list's shortcuts.
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(null)
        }
      }}
      onBlur={() => finish(null)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}

interface DetailProps {
  s: SessionView
  labels: LabelDef[]
  labelMenuOpen: boolean
  onLabelMenu(open: boolean): void
  onJump(): void
  onSeen(): void
  onUnread(): void
  onHide(): void
}

export function Detail({ s, labels, labelMenuOpen, onLabelMenu, onJump, onSeen, onUnread, onHide }: DetailProps) {
  const [copied, setCopied] = useState<string | null>(null)
  const today = clipToDay(s.intervals, localDayStart(Date.now()))
  const copy = (label: string, text: string) => {
    void api.copyText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 1500)
  }
  return (
    <div className="detail">
      {s.lastPrompt && (
        <section>
          <h4>Last prompt</h4>
          <p className="text">{s.lastPrompt}</p>
        </section>
      )}
      {s.lastReply && (
        <section>
          <h4>Last reply</h4>
          <p className="text">{s.lastReply}</p>
        </section>
      )}
      <dl>
        <dt>Status</dt>
        <dd>
          {s.status} · {s.reason}
          {s.lightGuess ? ' (guessed)' : ''}
        </dd>
        <dt>Branch</dt>
        <dd>{s.branches.length ? s.branches.join(' → ') : '—'}</dd>
        <dt>Folder</dt>
        <dd className="mono">{s.homeDir}</dd>
        <dt>Span</dt>
        <dd>
          {absTime(s.firstActivity)} – {absTime(s.lastActivity)}
        </dd>
        <dt>Time</dt>
        <dd>
          {formatDuration(sumMs(today))} today · {formatDuration(s.activeMs)} in total
          {today.length > 0 && <div className="periods">{today.map(([a, b]) => clockRange(a, b)).join(' · ')}</div>}
        </dd>
        <dt>Editor</dt>
        <dd>
          {s.editor}
          {s.version ? ` · ${AGENT_NAME[s.agent]} ${s.version}` : ` · ${AGENT_NAME[s.agent]}`}
        </dd>
        <dt>Session</dt>
        <dd className="mono">{s.id}</dd>
        {s.error && (
          <>
            <dt>Error</dt>
            <dd>{s.error}</dd>
          </>
        )}
      </dl>
      <div className="actions">
        <button className="primary" onClick={onJump}>
          Open
        </button>
        {s.light === 'red' || s.light === 'yellow' ? (
          <button onClick={onSeen} title="Ctrl+E">
            Mark as seen
          </button>
        ) : (
          <button onClick={onUnread} disabled={s.light === 'green'} title={s.light === 'green' ? 'Working – nothing to mark yet' : 'Ctrl+E (or Ctrl+U)'}>
            Mark as unread
          </button>
        )}
        <button onClick={() => copy('resume', s.agent === 'codex' ? `codex resume ${s.id}` : `claude --resume ${s.id}`)}>{copied === 'resume' ? 'Copied' : 'Copy resume command'}</button>
        <button onClick={() => copy('id', s.id)}>{copied === 'id' ? 'Copied' : 'Copy id'}</button>
        <div className="labels-anchor">
          <button className={`labels-btn ${s.labels.length ? 'has' : ''}`} aria-expanded={labelMenuOpen} title="Labels (Ctrl+L)" onClick={() => onLabelMenu(!labelMenuOpen)}>
            <svg viewBox="0 0 16 16" aria-hidden>
              <path d="M2 2.5h5.6l6.3 6.3-5.1 5.1L2.5 7.6z" />
              <circle cx="5.2" cy="5.6" r=".9" />
            </svg>
            Labels{s.labels.length ? ` (${s.labels.length})` : ''}
          </button>
          {labelMenuOpen && <LabelMenu s={s} defs={labels} onClose={() => onLabelMenu(false)} />}
        </div>
        <button className="push" onClick={onHide} title={s.hidden ? 'Show this session in the list again' : 'Leave this session out of the list. Its files are not touched.'}>
          {s.hidden ? 'Unhide' : 'Hide'}
        </button>
      </div>
    </div>
  )
}

const HOOK_TEXT: Record<HooksStatus, string> = {
  installed: 'Installed. Waiting and finished states come from Claude Code hook events.',
  partial: 'Partly installed. Reinstall to repair.',
  none: 'Not installed. Status is guessed from transcripts.',
  error: 'Could not read ~/.claude/settings.json.'
}

export function SettingsPanel({ info, hooks, onChange, onClose }: { info: SettingsInfo; hooks: HooksStatus; onChange(i: SettingsInfo): void; onClose(): void }) {
  const [draft, setDraft] = useState<AppSettings>(info.settings)
  const save = async (patch: Partial<AppSettings> & { openAtLogin?: boolean }) => onChange(await api.setSettings(patch))
  const field = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setDraft((d) => ({ ...d, [k]: v }))

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            <svg viewBox="0 0 16 16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </header>

        <section>
          <h3>Claude Code hooks</h3>
          <p className="muted">{HOOK_TEXT[hooks]}</p>
          <div className="actions">
            {hooks !== 'installed' && (
              <button className="primary" onClick={() => void api.installHooks()}>
                Install hooks…
              </button>
            )}
            {(hooks === 'installed' || hooks === 'partial') && <button onClick={() => void api.uninstallHooks()}>Remove hooks…</button>}
          </div>
        </section>

        <section>
          <h3>Notifications</h3>
          <label className="check">
            <input type="checkbox" checked={info.settings.notifyOnYellow} onChange={(e) => void save({ notifyOnYellow: e.target.checked })} />
            Also notify when a session finishes a turn
          </label>
          <p className="muted">You are always notified when a session starts waiting for you.</p>
        </section>

        <section>
          <h3>Sound</h3>
          <label className="check">
            <input type="checkbox" checked={info.settings.soundOnFinish} onChange={(e) => void save({ soundOnFinish: e.target.checked })} />
            Play a sound when a session finishes a turn
          </label>
          <label className="check indent">
            <input
              type="checkbox"
              disabled={!info.settings.soundOnFinish}
              checked={info.settings.soundOnlyWhenAway}
              onChange={(e) => void save({ soundOnlyWhenAway: e.target.checked })}
            />
            Only when the session's own window is not in front
          </label>
          <div className="actions">
            <button onClick={() => playBlop()}>Play sound</button>
          </div>
        </section>

        <section>
          <h3>Editor</h3>
          <div className="grid">
            <label htmlFor="editorCommand">Command</label>
            <input id="editorCommand" value={draft.editorCommand} onChange={(e) => field('editorCommand', e.target.value)} onBlur={() => void save({ editorCommand: draft.editorCommand })} />
            <label htmlFor="uriScheme">URI scheme</label>
            <input id="uriScheme" value={draft.uriScheme} onChange={(e) => field('uriScheme', e.target.value)} onBlur={() => void save({ uriScheme: draft.uriScheme })} />
            <label htmlFor="delay">Delay (ms)</label>
            <input
              id="delay"
              type="number"
              min={0}
              step={100}
              value={draft.launchDelayMs}
              onChange={(e) => field('launchDelayMs', Number(e.target.value))}
              onBlur={() => void save({ launchDelayMs: draft.launchDelayMs })}
            />
          </div>
          <p className="muted">Use "cursor" for both fields with Cursor. The delay is the wait between focusing the window and opening the session.</p>
        </section>

        <section>
          <h3>Time tracking</h3>
          <div className="grid">
            <label htmlFor="gap">Idle gap (min)</label>
            <input
              id="gap"
              type="number"
              min={1}
              step={1}
              value={draft.idleGapMinutes}
              onChange={(e) => field('idleGapMinutes', Number(e.target.value))}
              onBlur={() => draft.idleGapMinutes >= 1 && void save({ idleGapMinutes: draft.idleGapMinutes })}
            />
          </div>
          <p className="muted">A pause longer than this ends an active period. Time is saved as one JSON file per day.</p>
          <div className="actions">
            <button onClick={() => void api.openTimeFolder()}>Open time folder</button>
          </div>
        </section>

        <section>
          <h3>Shortcuts</h3>
          <div className="grid">
            <label htmlFor="scOpen">Open list</label>
            <input
              id="scOpen"
              value={draft.shortcuts.openList}
              onChange={(e) => field('shortcuts', { ...draft.shortcuts, openList: e.target.value })}
              onBlur={() => void save({ shortcuts: draft.shortcuts })}
            />
            <label htmlFor="scJump">Most urgent</label>
            <input
              id="scJump"
              value={draft.shortcuts.jumpUrgent}
              onChange={(e) => field('shortcuts', { ...draft.shortcuts, jumpUrgent: e.target.value })}
              onBlur={() => void save({ shortcuts: draft.shortcuts })}
            />
          </div>
          {info.shortcutErrors.length > 0 && <p className="error">Could not register: {info.shortcutErrors.join(', ')}. Another app may be using it.</p>}
          <p className="muted">
            "Most urgent" jumps to the session that has waited longest (red before yellow). Press again for the next one. In the list: ↑↓, Enter, → details,
            Ctrl+1…9 open row, Ctrl+E toggle seen/unread, Ctrl+U mark as unread, Ctrl+L labels, F2 rename, Ctrl+plus/minus/0 text size, Esc clear/minimize. Closing the window hides it to the tray; Quit is in the tray menu.
          </p>
        </section>

        <section>
          <label className="check">
            <input type="checkbox" checked={info.openAtLogin} onChange={(e) => void save({ openAtLogin: e.target.checked })} />
            Start at login
          </label>
        </section>

        <footer className="muted">
          Version {info.version} · data in <span className="mono">{info.dataDir}</span>
        </footer>
      </div>
    </div>
  )
}

/** Active time per day (spec 3.7), read from the stored day files. */
export function TimeView({ snap, onJump, onMessage }: { snap: Snapshot; onJump(id: string): void; onMessage(m: string): void }) {
  const today = dayKey(Date.now())
  const [date, setDate] = useState(today)
  const [day, setDay] = useState<DayFile | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => rootRef.current?.focus(), [])

  // Today's file changes while sessions run; past days are fixed.
  const liveKey = date === today ? snap : null
  useEffect(() => {
    let cancelled = false
    void api.getTimeDay(date).then((d) => !cancelled && setDay(d))
    return () => {
      cancelled = true
    }
  }, [date, liveKey])

  const rows = useMemo(() => (day && day.date === date ? dayRows(day) : []), [day, date])
  const groups = groupTimeRows(rows)
  const total = rows.reduce((sum, r) => sum + r.ms, 0)
  const working = new Set(snap.sessions.filter((s) => s.status === 'busy').map((s) => s.id))

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setDate((d) => shiftDay(d, -1))
    else if (e.key === 'ArrowRight') setDate((d) => (d < today ? shiftDay(d, 1) : d))
    else return
    e.preventDefault()
  }

  const copy = () => {
    if (!day) return
    void api.copyText(dayCsv(day))
    onMessage(`Copied ${rows.length} session${rows.length === 1 ? '' : 's'} for ${dayLabel(date)} as CSV.`)
  }

  return (
    <div className="timeview" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="daynav">
        <button className="icon-btn" title="Previous day (←)" onClick={() => setDate((d) => shiftDay(d, -1))}>
          <svg viewBox="0 0 16 16" aria-hidden><path d="M10 4l-4 4 4 4" /></svg>
        </button>
        <strong className="day-title">{date === today ? 'Today' : dayLabel(date)}</strong>
        <button className="icon-btn" title="Next day (→)" disabled={date >= today} onClick={() => setDate((d) => shiftDay(d, 1))}>
          <svg viewBox="0 0 16 16" aria-hidden><path d="M6 4l4 4-4 4" /></svg>
        </button>
        {date !== today && (
          <button className="chip" onClick={() => setDate(today)}>
            Today
          </button>
        )}
        <span className="spacer" />
        <span className="day-total" title="Total active time this day">
          {formatDuration(total)}
        </span>
      </div>

      <div className="list">
        {rows.length === 0 && <div className="empty">{snap.scanning ? 'Reading sessions…' : 'No active sessions this day.'}</div>}
        {groups.map((g) => (
          <section key={g.repo} className="group">
            <h2 className="time-group">
              <span>{g.repo}</span>
              <span className="subtotal">{formatDuration(g.ms)}</span>
            </h2>
            {g.rows.map((r) => (
              <div key={r.id} className="row trow" onClick={() => onJump(r.id)} title="Open session">
                <div className="row-main">
                  <div className="row-title">
                    {working.has(r.id) && <span className="live-dot" title="Working now" />}
                    <AgentIcon agent={r.entry.agent ?? 'claude'} />
                    {r.entry.title}
                  </div>
                  <div className="row-sub">
                    <Where worktree={r.entry.worktree} branch={r.entry.branch} />
                  </div>
                  <div className="periods">{r.intervals.map(([a, b]) => clockRange(a, b)).join(' · ')}</div>
                </div>
                <div className="row-side duration">{formatDuration(r.ms)}</div>
              </div>
            ))}
          </section>
        ))}
      </div>

      <div className="timeactions">
        <button onClick={copy} disabled={!rows.length}>
          Copy day as CSV
        </button>
        <button onClick={() => void api.openTimeFolder()}>Open time folder</button>
      </div>
    </div>
  )
}
