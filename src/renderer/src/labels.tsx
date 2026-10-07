// Labels on sessions (spec 3.8): the icons, the comma-separated list on a row, and the label menu.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LABEL_ICONS, type LabelDef, type LabelIcon, type SessionView } from '../../shared/types.ts'

const api = window.api

export const ICON_NAME: Record<LabelIcon, string> = {
  merge: 'Merge',
  flag: 'Flag',
  users: 'People',
  bug: 'Bug',
  star: 'Star',
  clock: 'Later',
  rocket: 'Release',
  question: 'Question',
  bookmark: 'Bookmark',
  block: 'Blocked'
}

const GLYPHS: Record<LabelIcon, ReactNode> = {
  merge: (
    <>
      <circle cx="4.5" cy="3.5" r="1.7" />
      <circle cx="4.5" cy="12.5" r="1.7" />
      <circle cx="11.5" cy="8" r="1.7" />
      <path d="M4.5 5.2v5.6M4.5 5.6c0 2 1.8 2.4 5.3 2.4" />
    </>
  ),
  flag: <path d="M3.5 14.5V2M3.5 2.5h8.5l-2 3 2 3H3.5" />,
  users: (
    <>
      <circle cx="6" cy="5.3" r="2.3" />
      <path d="M1.8 13.5c.4-2.4 2.1-3.8 4.2-3.8s3.8 1.4 4.2 3.8M10.7 3.2a2.2 2.2 0 0 1 0 4.3M11.9 9.9c1.3.5 2.1 1.7 2.3 3.6" />
    </>
  ),
  bug: (
    <>
      <rect x="5" y="5" width="6" height="8.5" rx="3" />
      <path d="M6.2 5a1.8 1.8 0 0 1 3.6 0M2.5 7.5H5M11 7.5h2.5M2.5 11H5M11 11h2.5M8 8v5.5" />
    </>
  ),
  star: <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.5V8l2.4 1.5" />
    </>
  ),
  rocket: <path d="M9.6 2.6c2.2-.7 3.8-.7 3.9-.6.1.1.1 1.7-.6 3.9L8.4 10.4 5.6 7.6zM5.6 7.6 3 7.2l2.1-2.4h3.1M8.4 10.4l.4 2.6 2.4-2.1V7.8M4.6 11.4l-2.1 2.1" />,
  question: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M8 11.4v.1" />
    </>
  ),
  bookmark: <path d="M4 2h8v12l-4-3-4 3z" />,
  block: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M3.6 12.4l8.8-8.8" />
    </>
  )
}

export function LabelGlyph({ icon }: { icon: LabelIcon }) {
  return (
    <svg className="label-icon" viewBox="0 0 16 16" aria-hidden>
      {GLYPHS[icon]}
    </svg>
  )
}

/** The session's labels on one line: "<icon> Pending merge, <icon> Needs attention". */
export function LabelList({ ids, defs }: { ids: string[]; defs: LabelDef[] }) {
  const shown = defs.filter((d) => ids.includes(d.id))
  if (!shown.length) return null
  return (
    <span className="labels" title={shown.map((d) => d.name).join(', ')}>
      {shown.map((d, i) => (
        <span key={d.id} className="label">
          <LabelGlyph icon={d.icon} />
          {d.name}
          {i < shown.length - 1 && ','}
        </span>
      ))}
    </span>
  )
}

/** Checkbox list of all labels, plus a field to add your own with an icon. */
export function LabelMenu({ s, defs, onClose }: { s: SessionView; defs: LabelDef[]; onClose(): void }) {
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<LabelIcon>('bookmark')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' })
    ref.current?.querySelector('input')?.focus()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element
      // The Labels button toggles the menu itself.
      if (!ref.current?.contains(t) && !t.closest?.('.labels-btn')) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const add = () => {
    if (!name.trim()) return
    void api.addLabel(s.id, name.trim(), icon)
    setName('')
  }

  const remove = (d: LabelDef) => {
    if (confirm(`Delete the label "${d.name}"? It is taken off every session that has it.`)) void api.removeLabel(d.id)
  }

  return (
    <div
      className="label-menu"
      ref={ref}
      role="dialog"
      aria-label="Labels"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Keys here belong to the menu, not to the list's shortcuts.
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
    >
      <ul>
        {defs.map((d) => (
          <li key={d.id}>
            <label>
              <input type="checkbox" checked={s.labels.includes(d.id)} onChange={(e) => void api.setLabel(s.id, d.id, e.target.checked)} />
              <LabelGlyph icon={d.icon} />
              <span className="name">{d.name}</span>
            </label>
            <button className="remove" title={`Delete the label "${d.name}"`} onClick={() => remove(d)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="new-label">
        <input
          value={name}
          maxLength={40}
          placeholder="New label…"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <div className="icon-picker" role="radiogroup" aria-label="Icon">
          {LABEL_ICONS.map((ic) => (
            <button key={ic} role="radio" aria-checked={icon === ic} className={icon === ic ? 'on' : ''} title={ICON_NAME[ic]} onClick={() => setIcon(ic)}>
              <LabelGlyph icon={ic} />
            </button>
          ))}
        </div>
        <button className="add" disabled={!name.trim()} onClick={add}>
          Add label
        </button>
      </div>
    </div>
  )
}
