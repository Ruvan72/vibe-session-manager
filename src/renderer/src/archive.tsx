import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DebugActions } from '../../shared/api.ts'
import type { ArchiveDoc, ArchiveHit, ArchiveOpenState, ArchiveStatus } from '../../shared/types.ts'
import { AgentIcon, Where } from './components.tsx'
import { Highlighted, Markdown } from './markdown.tsx'
import { absTime, formatBytes, highlightRegex, relTime } from './view.ts'

const api = window.api

const NO_STATUS: ArchiveStatus = { enabled: false, running: false, done: 0, total: 0, sessions: 0, bytes: 0, version: 0, dir: '', error: null }

/** Tooltip for the open button: what clicking does, given what is still on disk. */
function openTitle(s: { agent: ArchiveHit['agent']; open: ArchiveOpenState }): string {
  if (s.agent === 'cowork') return 'Cowork sessions open in the Claude app. Copies the title to look for there.'
  if (!s.open.needsRestore) return 'Open the session where it was started'
  const gone = [!s.open.folderExists && 'its folder', !s.open.transcriptExists && 'its transcript'].filter(Boolean).join(' and ')
  return `${gone[0].toUpperCase()}${gone.slice(1)} ${gone.includes(' and ') ? 'are' : 'is'} gone. Asks you, brings ${gone.includes(' and ') ? 'them' : 'it'} back and opens the session.`
}

function MissingBadge({ open }: { open: ArchiveOpenState }) {
  if (!open.needsRestore) return null
  const text = !open.folderExists ? (open.transcriptExists ? 'Folder gone' : 'Folder and transcript gone') : 'Transcript gone'
  return <span className="reason reason-yellow">{text}</span>
}

interface Props {
  active: boolean
  /** Another panel is on top and has the keys. */
  paused: boolean
  debug: DebugActions | null
  now: number
  onMessage(m: string): void
}

/** Every archived conversation: search on top, then the results and a Markdown reader with the matches marked. */
export function ArchiveView({ active, paused, debug, now, onMessage }: Props) {
  const [status, setStatus] = useState<ArchiveStatus>(NO_STATUS)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ArchiveHit[]>([])
  const [searched, setSearched] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [doc, setDoc] = useState<ArchiveDoc | null>(null)
  const [count, setCount] = useState(0)
  const [match, setMatch] = useState(0)
  // Goes up after opening a session, since that can bring back its folder or transcript.
  const [tick, setTick] = useState(0)
  const [openFirst, setOpenFirst] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const articleRef = useRef<HTMLElement>(null)

  useEffect(() => {
    void api.getArchiveStatus().then(setStatus)
    return api.onArchiveStatus(setStatus)
  }, [])

  useEffect(() => {
    if (debug?.archiveQuery !== undefined) setQuery(debug.archiveQuery)
    if (debug?.archiveOpenFirst) setOpenFirst(true)
  }, [debug])

  const showIntro = !status.enabled && status.sessions === 0

  // Also when the reader closes: what had the focus is gone, and the keys must keep working.
  useEffect(() => {
    if (active && !openId) inputRef.current?.focus()
  }, [active, openId, showIntro])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const t = setTimeout(() => {
      void api.searchArchive(query).then((h) => {
        if (cancelled) return
        setHits(h)
        setSearched(true)
      })
    }, 60)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [active, query, status.version, tick])

  useEffect(() => {
    if (openFirst && hits[0]) {
      setOpenId(hits[0].id)
      setSelectedId(hits[0].id)
      setOpenFirst(false)
    }
  }, [openFirst, hits])

  useEffect(() => {
    if (!openId) {
      setDoc(null)
      return
    }
    let cancelled = false
    void api.readArchive(openId).then((d) => !cancelled && setDoc(d))
    return () => {
      cancelled = true
    }
  }, [openId, status.version, tick])

  // A long conversation takes a moment to mark, so typing stays ahead of it.
  const shownQuery = useDeferredValue(query)
  const re = useMemo(() => highlightRegex(shownQuery), [shownQuery])
  const docId = doc?.id ?? null
  const docText = doc?.markdown ?? null

  // A new search or another conversation starts at its first match, or at the top without one.
  useLayoutEffect(() => {
    setMatch(0)
    if (!re) bodyRef.current?.scrollTo(0, 0)
  }, [docId, re])

  const scrolledTo = useRef('')
  useLayoutEffect(() => {
    const marks = articleRef.current?.querySelectorAll('mark') ?? []
    setCount(marks.length)
    if (!marks.length) return
    const at = Math.min(match, marks.length - 1)
    marks.forEach((m, i) => m.classList.toggle('current', i === at))
    // New text in a conversation that is still running must not move what is being read.
    const place = `${docId}|${re}|${at}`
    if (place !== scrolledTo.current) marks[at].scrollIntoView({ block: 'center' })
    scrolledTo.current = place
  }, [docId, docText, re, match])

  const selectedIndex = Math.max(0, hits.findIndex((h) => h.id === selectedId))
  const selected = hits[selectedIndex] ?? null

  useEffect(() => {
    if (selected) listRef.current?.querySelector(`[data-id="${CSS.escape(selected.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected?.id])

  const stepMatch = (by: number) => count && setMatch((m) => (m + by + count) % count)

  const openSession = async (id: string) => {
    const res = await api.openArchived(id)
    if (res.message) onMessage(res.message)
    setTick((t) => t + 1)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    } else if (e.key === 'F3') {
      e.preventDefault()
      stepMatch(e.shiftKey ? -1 : 1)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (e.target !== inputRef.current) return
      e.preventDefault()
      const next = hits[Math.min(hits.length - 1, Math.max(0, selectedIndex + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) setSelectedId(next.id)
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault()
      if (mod) {
        if (selected) void openSession(selected.id)
      } else if (selected && selected.id !== openId) setOpenId(selected.id)
      else stepMatch(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (openId) setOpenId(null)
      else if (query) setQuery('')
      else void api.minimize()
    } else if (e.target !== inputRef.current && e.key.length === 1 && !mod && !e.altKey) {
      inputRef.current?.focus()
    }
  }

  // On the window, like the list's shortcuts: a click on something that is not focusable moves focus to <body>.
  const keyHandler = useRef(onKeyDown)
  keyHandler.current = onKeyDown
  useEffect(() => {
    if (!active || paused) return
    const h = (e: KeyboardEvent) => keyHandler.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [active, paused])

  const turnOn = () => void api.setSettings({ archiveConversations: true })

  return (
    <div className="archive" hidden={!active}>
      {showIntro ? (
        <div className="archive-intro">
          <h2>Keep every conversation</h2>
          <p>Turn this on to keep a copy of all your Claude Code, Cowork and Codex conversations, and search and read them here. They stay after a window is closed, a worktree is removed or Claude Code cleans up old sessions.</p>
          <p className="muted">
            The copies are in <span className="mono">{status.dir}</span>. They are not encrypted and nothing is deleted automatically. They include everything the agents read, which can be .env files and tokens, so keep this folder out of cloud sync.
          </p>
          <div className="actions">
            <button className="primary" onClick={turnOn}>
              Turn on archive
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={`search ${query ? 'active' : ''}`}>
            <svg viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
            <input ref={inputRef} value={query} placeholder="Search every archived conversation…" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
            {query && (
              <button className="clear" title="Clear (Esc)" onClick={() => setQuery('')}>
                ×
              </button>
            )}
          </div>

          <div className="archive-status">
            <span>
              {status.running ? `Archiving ${status.done} of ${status.total}… ` : ''}
              {status.sessions} session{status.sessions === 1 ? '' : 's'} · {formatBytes(status.bytes)}
              {query ? ` · ${hits.length} match${hits.length === 1 ? '' : 'es'}` : ''}
            </span>
            {!status.enabled && (
              <>
                <span className="reason reason-yellow">Archive is off</span>
                <button className="link" onClick={turnOn}>
                  Turn on
                </button>
              </>
            )}
            {status.error && <span className="reason reason-red" title={status.error}>A session could not be copied</span>}
            <span className="spacer" />
            <button className="link" onClick={() => void api.openArchiveFolder()}>
              Open folder
            </button>
          </div>

          <div className={`archive-panes ${openId ? 'reading' : ''}`}>
            <div className="list archive-results" ref={listRef} role="listbox">
              {hits.length === 0 && <div className="empty">{!searched ? 'Reading the archive…' : query ? 'No conversations match.' : status.running ? 'Archiving…' : 'Nothing archived yet.'}</div>}
              {hits.map((h) => (
                <div
                  key={h.id}
                  className={`row archive-row ${h.id === selected?.id ? 'selected' : ''} ${h.id === openId ? 'open' : ''}`}
                  data-id={h.id}
                  role="option"
                  aria-selected={h.id === selected?.id}
                  title="Read the conversation"
                  onClick={() => {
                    setSelectedId(h.id)
                    setOpenId(h.id)
                  }}
                >
                  <div className="row-main">
                    <div className="row-title">
                      <AgentIcon agent={h.agent} />
                      <Highlighted text={h.title} re={re} />
                    </div>
                    <div className="row-sub">
                      <Where repo={h.repo} worktree={h.worktree} branch={h.branch} />
                      <MissingBadge open={h.open} />
                    </div>
                    {h.snippet && (
                      <div className="snippet">
                        <Highlighted text={h.snippet} re={re} />
                      </div>
                    )}
                  </div>
                  <div className="row-side">
                    <time title={new Date(h.lastActivity).toLocaleString()}>{relTime(h.lastActivity, now)}</time>
                    <button
                      className="archive-open"
                      title={openTitle(h)}
                      onClick={(e) => {
                        e.stopPropagation()
                        void openSession(h.id)
                      }}
                    >
                      {h.open.needsRestore ? 'Restore' : 'Open'}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="reader" hidden={!openId}>
              {doc && (
                <>
                  <header className="reader-head">
                    <div className="reader-title">
                      <button className="icon-btn reader-back" title="Back to the results (Esc)" onClick={() => setOpenId(null)}>
                        <svg viewBox="0 0 16 16" aria-hidden><path d="M10 4l-4 4 4 4" /></svg>
                      </button>
                      <AgentIcon agent={doc.agent} />
                      <strong title={doc.title}>{doc.title}</strong>
                    </div>
                    <div className="row-sub">
                      <Where repo={doc.repo} worktree={doc.worktree} branch={doc.branch} />
                      <span title={doc.id}>{absTime(doc.firstActivity)} – {absTime(doc.lastActivity)}</span>
                      <MissingBadge open={doc.open} />
                    </div>
                    <div className="reader-actions">
                      <button className="primary" title={openTitle(doc)} onClick={() => void openSession(doc.id)}>
                        {doc.open.needsRestore ? 'Restore and open' : 'Open'}
                      </button>
                      <button title="Show conversation.md in Explorer" onClick={() => void api.revealArchived(doc.id)}>
                        Show file
                      </button>
                      <span className="spacer" />
                      {re && (
                        <span className="match-nav">
                          <span>{count ? `${Math.min(match, count - 1) + 1} of ${count}` : 'No matches in the text'}</span>
                          <button className="icon-btn" title="Previous match (Shift+Enter)" disabled={!count} onClick={() => stepMatch(-1)}>
                            <svg viewBox="0 0 16 16" aria-hidden><path d="M4 10l4-4 4 4" /></svg>
                          </button>
                          <button className="icon-btn" title="Next match (Enter)" disabled={!count} onClick={() => stepMatch(1)}>
                            <svg viewBox="0 0 16 16" aria-hidden><path d="M4 6l4 4 4-4" /></svg>
                          </button>
                        </span>
                      )}
                    </div>
                  </header>
                  <div className="reader-body" ref={bodyRef}>
                    <article className="md" ref={articleRef}>
                      {doc.markdown ? <Markdown source={doc.markdown} re={re} onLink={(url) => void api.openLink(url)} /> : <p className="muted">This session has no prompts or replies yet.</p>}
                    </article>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
