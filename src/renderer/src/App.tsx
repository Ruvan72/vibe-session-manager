import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SettingsInfo } from '../../shared/api.ts'
import type { LabelDef, Light, SearchHit, SessionView, Snapshot } from '../../shared/types.ts'
import { AgentIcon, Detail, LightIcon, RepoFilter, SettingsPanel, TimeView, TitleEditor, Where } from './components.tsx'
import { LabelGlyph, LabelList } from './labels.tsx'
import { playBlop } from './sound.ts'
import { flattenGroups, groupSessions, LIGHT_LABEL, relTime, repoOptions, visibleSessions, type Filters, type Range } from './view.ts'

const api = window.api
const EMPTY: Snapshot = { sessions: [], hooks: 'none', scanning: true, counts: { red: 0, yellow: 0, green: 0 }, searchVersion: 0, labels: [] }

type Tab = 'sessions' | 'time'

export function App() {
  const [snap, setSnap] = useState<Snapshot>(EMPTY)
  const [tab, setTab] = useState<Tab>('sessions')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [filters, setFilters] = useState<Filters>({ lights: [], liveOnly: false, range: '3d' })
  const [grouped, setGrouped] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [labelMenuFor, setLabelMenuFor] = useState<string | null>(null)
  const [renameFor, setRenameFor] = useState<string | null>(null)
  const [settings, setSettings] = useState<SettingsInfo | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  // Debug helper (VSM_DEBUG): expand the first row once the list has rows.
  const [expandFirst, setExpandFirst] = useState<false | 'row' | 'labels'>(false)
  // Debug helper (VSM_DEBUG): remount the repo filter with its dropdown open.
  const [repoMenuDebug, setRepoMenuDebug] = useState(false)
  // Debug helper (VSM_DEBUG): open the rename field on the first Claude Code row once there is one.
  const [renameFirst, setRenameFirst] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api.getSnapshot().then(setSnap)
    const offs = [
      api.onSnapshot(setSnap),
      api.onFocusSearch(() => {
        setTab('sessions')
        searchRef.current?.focus()
        searchRef.current?.select()
      }),
      api.onToast(setToast),
      api.onPing(() => playBlop()),
      api.onDebug((d) => {
        if (d.query !== undefined) setQuery(d.query)
        if (d.grouped) setGrouped(true)
        if (d.repoMenu) setRepoMenuDebug(true)
        if (d.rename) setRenameFirst(true)
        if (d.settings) void api.getSettings().then(setSettings)
        if (d.expandFirst) setExpandFirst(d.labelMenu ? 'labels' : 'row')
        if (d.tab) setTab(d.tab)
      })
    ]
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      offs.forEach((off) => off())
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(t)
  }, [toast])

  // Search runs in the main process, where the conversation text is. Re-run when searchable content changes.
  useEffect(() => {
    if (!query.trim()) {
      setHits(null)
      return
    }
    let cancelled = false
    const t = setTimeout(() => void api.search(query).then((h) => !cancelled && setHits(h)), 60)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, snap.searchVersion])

  const visible = useMemo(() => visibleSessions(snap.sessions, filters, hits, now), [snap, filters, hits, now])
  const groups = useMemo(() => (grouped ? groupSessions(visible) : null), [visible, grouped])
  const ordered = useMemo(() => (groups ? flattenGroups(groups) : visible), [groups, visible])
  const snippets = useMemo(() => new Map((hits ?? []).map((h) => [h.id, h.snippet])), [hits])
  const selectedIndex = Math.max(0, ordered.findIndex((s) => s.id === selectedId))
  const selected = ordered[selectedIndex] ?? null

  useEffect(() => {
    if (expandFirst && ordered[0]) {
      setExpandedId(ordered[0].id)
      setSelectedId(ordered[0].id)
      if (expandFirst === 'labels') setLabelMenuFor(ordered[0].id)
      setExpandFirst(false)
    }
  }, [expandFirst, ordered])

  useEffect(() => {
    const first = renameFirst && ordered.find((s) => s.agent === 'claude')
    if (!first) return
    setSelectedId(first.id)
    setRenameFor(first.id)
    setRenameFirst(false)
  }, [renameFirst, ordered])

  useEffect(() => {
    if (!selected) return
    listRef.current?.querySelector(`[data-id="${CSS.escape(selected.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected?.id])

  const jump = useCallback(async (s: SessionView) => {
    setSelectedId(s.id)
    const res = await api.jump(s.id)
    if (!res.ok && res.message) setToast(res.message)
  }, [])

  const markSeen = useCallback((s: SessionView) => void api.markSeen(s.id), [])
  const markUnread = useCallback((s: SessionView) => void api.markUnread(s.id), [])
  const repos = useMemo(() => repoOptions(snap.sessions, !!filters.showHidden), [snap.sessions, filters.showHidden])
  const hiddenCount = snap.sessions.filter((s) => s.hidden).length
  const labelCounts = new Map<string, number>()
  for (const s of snap.sessions) if (!s.hidden) for (const l of s.labels) labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1)
  const setHidden = (s: SessionView, hidden: boolean) => {
    void api.setHidden(s.id, hidden)
    if (hidden && !filters.showHidden) setToast('Session hidden. The eye at the top shows hidden sessions.')
  }

  const rename = async (s: SessionView, title: string | null) => {
    setRenameFor(null)
    if (title === null || !title.trim() || title.trim() === s.title) return
    try {
      await api.rename(s.id, title)
    } catch (e: any) {
      setToast(`Could not rename the session: ${e?.message ?? e}`)
    }
  }

  const jumpById = (id: string) => {
    const s = snap.sessions.find((x) => x.id === id)
    if (s) void jump(s)
    else setToast('This session no longer exists in Claude Code.')
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const inSearch = e.target === searchRef.current
    const caretAtEnd = !inSearch || (searchRef.current!.selectionStart === query.length && searchRef.current!.selectionEnd === query.length)
    const mod = e.ctrlKey || e.metaKey
    if (settings) {
      if (e.key === 'Escape') setSettings(null)
      return
    }
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      setTab('sessions')
      // The search field only exists on the Sessions tab; wait for it after switching.
      setTimeout(() => {
        searchRef.current?.focus()
        searchRef.current?.select()
      })
      return
    }
    if (mod && e.key.toLowerCase() === 't') {
      e.preventDefault()
      setTab((t) => (t === 'sessions' ? 'time' : 'sessions'))
      return
    }
    if (tab === 'time') {
      if (e.key === 'Escape') void api.minimize()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const i = Math.min(ordered.length - 1, Math.max(0, selectedIndex + (e.key === 'ArrowDown' ? 1 : -1)))
      if (ordered[i]) setSelectedId(ordered[i].id)
    } else if (e.key === 'Enter' && selected && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault()
      void jump(selected)
    } else if (e.key === 'ArrowRight' && selected && caretAtEnd && !e.shiftKey) {
      e.preventDefault()
      setExpandedId(selected.id)
    } else if (e.key === 'ArrowLeft' && expandedId && caretAtEnd && !e.shiftKey) {
      e.preventDefault()
      setExpandedId(null)
    } else if (mod && /^[1-9]$/.test(e.key)) {
      e.preventDefault()
      const s = ordered[Number(e.key) - 1]
      if (s) void jump(s)
    } else if (mod && e.key.toLowerCase() === 'e' && selected) {
      // Toggle, like the button in the details: red/yellow → seen, grey → unread. A working session has nothing to mark.
      e.preventDefault()
      if (selected.light === 'red' || selected.light === 'yellow') markSeen(selected)
      else if (selected.light === 'grey') markUnread(selected)
    } else if (mod && e.key.toLowerCase() === 'l' && selected) {
      e.preventDefault()
      setSelectedId(selected.id)
      setExpandedId(selected.id)
      setLabelMenuFor(selected.id)
    } else if (mod && e.key.toLowerCase() === 'u' && selected) {
      e.preventDefault()
      markUnread(selected)
    } else if (e.key === 'F2' && selected?.agent === 'claude') {
      e.preventDefault()
      setRenameFor(selected.id)
    } else if (mod && e.key === ',') {
      e.preventDefault()
      void api.getSettings().then(setSettings)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (query) setQuery('')
      else if (expandedId) setExpandedId(null)
      else void api.minimize()
    } else if (!inSearch && e.key.length === 1 && !mod && !e.altKey) {
      searchRef.current?.focus()
    }
  }

  // Listen on the window, not the app element: clicking a row (not focusable) moves focus to <body>,
  // and the shortcuts must keep working then. The ref always holds the handler of the latest render.
  const keyHandler = useRef(onKeyDown)
  keyHandler.current = onKeyDown
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandler.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const toggleLight = (l: Light) =>
    setFilters((f) => ({ ...f, lights: f.lights.includes(l) ? f.lights.filter((x) => x !== l) : [...f.lights, l] }))

  const row = (s: SessionView) => {
    const index = ordered.indexOf(s)
    return (
      <SessionRow
        key={s.id}
        s={s}
        index={index}
        now={now}
        selected={s.id === selected?.id}
        expanded={s.id === expandedId}
        snippet={snippets.get(s.id) ?? null}
        grouped={grouped}
        onJump={() => void jump(s)}
        onToggle={() => {
          setSelectedId(s.id)
          setExpandedId((id) => (id === s.id ? null : s.id))
        }}
        onSeen={() => markSeen(s)}
        onUnread={() => markUnread(s)}
        onHide={() => setHidden(s, !s.hidden)}
        labels={snap.labels}
        labelMenuOpen={labelMenuFor === s.id}
        onLabelMenu={(open) => setLabelMenuFor(open ? s.id : null)}
        onHover={() => setSelectedId(s.id)}
        renaming={renameFor === s.id}
        onRename={() => setRenameFor(s.id)}
        onRenameDone={(title) => void rename(s, title)}
      />
    )
  }

  return (
    <div className="app">
      <header className="titlebar">
        <span className="app-name">Vibe Session Manager</span>
        <span className="spacer" />
        <div className="tabs" role="tablist">
          {(['sessions', 'time'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} title="Switch view (Ctrl+T)" onClick={() => setTab(t)}>
              {t === 'sessions' ? 'Sessions' : 'Time'}
            </button>
          ))}
        </div>
        <button
          className={`icon-btn eye ${filters.showHidden ? 'on' : ''}`}
          aria-pressed={!!filters.showHidden}
          title={filters.showHidden ? 'Hide the hidden sessions again' : `Show hidden sessions (${hiddenCount})`}
          onClick={() => {
            setTab('sessions')
            setFilters((f) => ({ ...f, showHidden: !f.showHidden }))
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden>
            <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
            <circle cx="8" cy="8" r="2" />
            {!filters.showHidden && <path d="M2.5 13.5 13.5 2.5" />}
          </svg>
        </button>
        <span className="spacer" />
        <button className="icon-btn" title="Settings (Ctrl+,)" onClick={() => void api.getSettings().then(setSettings)}>
          <svg viewBox="0 0 16 16" className="filled" aria-hidden><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm6 3.3V7.2l-1.7-.4a4.6 4.6 0 0 0-.5-1.2l.9-1.5-1.1-1.1-1.5.9c-.4-.2-.8-.4-1.2-.5L8.8 2H7.2l-.4 1.7c-.4.1-.8.3-1.2.5l-1.5-.9L3 4.4l.9 1.5c-.2.4-.4.8-.5 1.2L2 7.2v1.6l1.7.4c.1.4.3.8.5 1.2l-.9 1.5L4.4 13l1.5-.9c.4.2.8.4 1.2.5l.4 1.7h1.6l.4-1.7c.4-.1.8-.3 1.2-.5l1.5.9 1.1-1.1-.9-1.5c.2-.4.4-.8.5-1.2l1.7-.4Z" /></svg>
        </button>
        <button className="icon-btn" title="Minimize (Esc)" onClick={() => void api.minimize()}>
          <svg viewBox="0 0 16 16" aria-hidden><path d="M4 8.5h8" /></svg>
        </button>
        <button className="icon-btn" title="Hide to tray" onClick={() => void api.hide()}>
          <svg viewBox="0 0 16 16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>

      {tab === 'time' ? (
        <TimeView snap={snap} onJump={jumpById} onMessage={setToast} />
      ) : (
      <>
      <div className="search">
        <svg viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
        <input
          ref={searchRef}
          autoFocus
          value={query}
          placeholder="Search chats, titles, repos, branches, claude/codex…"
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {query && (
          <button className="clear" title="Clear (Esc)" onClick={() => setQuery('')}>
            ×
          </button>
        )}
      </div>

      <div className="filters">
        {(['red', 'yellow', 'green'] as const).map((l) => (
          <button
            key={l}
            className={`chip chip-${l} ${filters.lights.includes(l) ? 'on' : ''}`}
            title={`${LIGHT_LABEL[l]} (${snap.counts[l]})`}
            aria-label={`${LIGHT_LABEL[l]} (${snap.counts[l]})`}
            aria-pressed={filters.lights.includes(l)}
            onClick={() => toggleLight(l)}
          >
            <LightIcon light={l} guess={false} small />
            {snap.counts[l]}
          </button>
        ))}
        <button
          className={`chip chip-icon ${filters.liveOnly ? 'on' : ''}`}
          title="Open only"
          aria-label="Open only"
          aria-pressed={filters.liveOnly}
          onClick={() => setFilters((f) => ({ ...f, liveOnly: !f.liveOnly }))}
        >
          <svg viewBox="0 0 16 16" aria-hidden>
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
            <path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3" />
          </svg>
        </button>
        <RepoFilter
          key={repoMenuDebug ? 'debug' : 'normal'}
          initialOpen={repoMenuDebug}
          options={repos}
          selected={filters.repos ?? []}
          onChange={(r) => setFilters((f) => ({ ...f, repos: r }))}
        />
        {snap.labels
          .filter((d) => labelCounts.has(d.id) || filters.label === d.id)
          .map((d) => (
            <button
              key={d.id}
              className={`chip chip-label ${filters.label === d.id ? 'on' : ''}`}
              title={`Only sessions labelled "${d.name}"`}
              onClick={() => setFilters((f) => ({ ...f, label: f.label === d.id ? null : d.id }))}
            >
              <LabelGlyph icon={d.icon} />
              {labelCounts.get(d.id) ?? 0} {d.name}
            </button>
          ))}
        <span className="spacer" />
        <div className={`segmented ${hits ? 'disabled' : ''}`} title={hits ? 'Search covers all time' : undefined}>
          {(['today', '3d', 'all'] as Range[]).map((r) => (
            <button key={r} className={filters.range === r ? 'on' : ''} onClick={() => setFilters((f) => ({ ...f, range: r }))}>
              {r === 'today' ? 'Today' : r === '3d' ? '3 days' : 'All'}
            </button>
          ))}
        </div>
        <button className={`chip ${grouped ? 'on' : ''}`} title="Group by repo" onClick={() => setGrouped((g) => !g)}>
          Group
        </button>
      </div>

      {snap.hooks !== 'installed' && (
        <div className="banner">
          <span>
            {snap.hooks === 'error'
              ? 'Could not read Claude Code settings.json. Status is guessed.'
              : 'Status is guessed from transcripts. Install hooks for reliable "waiting" alerts.'}
          </span>
          {snap.hooks !== 'error' && (
            <button className="link" onClick={() => void api.installHooks()}>
              Install hooks…
            </button>
          )}
        </div>
      )}

      <div className="list" ref={listRef} role="listbox">
        {ordered.length === 0 && (
          <div className="empty">{snap.scanning ? 'Reading sessions…' : hits ? 'No sessions match.' : 'No sessions in this period.'}</div>
        )}
        {groups
          ? groups.map((g) => (
              <section key={g.key} className="group">
                <h2>{g.label}</h2>
                {g.sessions.map(row)}
              </section>
            ))
          : ordered.map(row)}
      </div>

      </>
      )}

      <footer className="statusbar">
        <span>
          {tab === 'sessions' ? `${ordered.length} of ${snap.sessions.length}` : 'Active time; idle gaps not counted'}
          {snap.scanning ? ' · reading…' : ''}
        </span>
        <span className="spacer" />
        {tab === 'sessions' ? (
          <span className="keys">
            <kbd>Ctrl+F</kbd> search <kbd>↑↓</kbd> select <kbd>Enter</kbd> open <kbd>→</kbd> details <kbd>Ctrl+T</kbd> time
          </span>
        ) : (
          <span className="keys">
            <kbd>←→</kbd> day <kbd>Ctrl+T</kbd> sessions
          </span>
        )}
      </footer>

      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
      {settings && <SettingsPanel info={settings} hooks={snap.hooks} onChange={setSettings} onClose={() => setSettings(null)} />}
    </div>
  )
}

interface RowProps {
  s: SessionView
  index: number
  now: number
  selected: boolean
  expanded: boolean
  snippet: string | null
  grouped: boolean
  onJump(): void
  onToggle(): void
  onSeen(): void
  onUnread(): void
  onHide(): void
  labels: LabelDef[]
  labelMenuOpen: boolean
  onLabelMenu(open: boolean): void
  onHover(): void
  renaming: boolean
  onRename(): void
  /** The new title, or null when cancelled. */
  onRenameDone(title: string | null): void
}

function SessionRow({ s, index, now, selected, expanded, snippet, grouped, onJump, onToggle, onSeen, onUnread, onHide, labels, labelMenuOpen, onLabelMenu, onHover, renaming, onRename, onRenameDone }: RowProps) {
  const attention = s.light === 'red' || s.light === 'yellow'
  return (
    <div className={`row-wrap ${expanded ? 'expanded' : ''} ${s.hidden ? 'is-hidden' : ''}`}>
      <div
        className={`row light-${s.light} ${selected ? 'selected' : ''} ${attention ? 'attention' : ''}`}
        data-id={s.id}
        role="option"
        aria-selected={selected}
        onClick={(e) => {
          // Only the first click of a double-click toggles the details; the second is ignored.
          if (e.detail === 1) onToggle()
        }}
        onDoubleClick={() => {
          // Undo the first click's toggle, so the details stay as they were before the double-click.
          onToggle()
          onJump()
        }}
        onMouseMove={selected ? undefined : onHover}
        title={`Click: details · Double-click: open in ${s.editor}`}
      >
        <LightIcon light={s.light} guess={s.lightGuess} closed={s.status === 'closed'} title={s.status === 'closed' ? 'Closed' : `${LIGHT_LABEL[s.light]}${s.lightGuess ? ' (guessed)' : ''}: ${s.reason}`} />
        <div className="row-main">
          <div className="row-title editable">
            <span className="title-wrap">
              <AgentIcon agent={s.agent} />
              <span className="title-text">{s.title}</span>
              {s.agent === 'claude' && (
                <button
                  className="rename-btn"
                  title="Rename (F2)"
                  aria-label="Rename session"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRename()
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <svg viewBox="0 0 16 16" aria-hidden>
                    <path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2z" />
                  </svg>
                </button>
              )}
            </span>
            {renaming && <TitleEditor title={s.title} onDone={onRenameDone} />}
          </div>
          <div className="row-sub">
            <Where repo={grouped ? undefined : s.repo} worktree={s.worktree} branch={s.branch} />
            <LabelList ids={s.labels} defs={labels} />
            {attention && <span className={`reason reason-${s.light}`}>{s.reason}</span>}
            {s.error && <span className="reason reason-red">Could not read transcript</span>}
          </div>
          {snippet && <div className="snippet">{snippet}</div>}
        </div>
        <div className="row-side">
          <time title={new Date(s.lastActivity).toLocaleString()}>{relTime(s.lastActivity, now)}</time>
          {index < 9 && <span className="hint">Ctrl+{index + 1}</span>}
        </div>
        <button
          className="chevron"
          title={expanded ? 'Hide details (←)' : 'Details (→)'}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <svg viewBox="0 0 16 16" aria-hidden><path d={expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} /></svg>
        </button>
      </div>
      {expanded && <Detail s={s} labels={labels} labelMenuOpen={labelMenuOpen} onLabelMenu={onLabelMenu} onJump={onJump} onSeen={onSeen} onUnread={onUnread} onHide={onHide} />}
    </div>
  )
}
