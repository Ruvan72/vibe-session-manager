// Labels the user puts on sessions, e.g. "Pending merge" (spec 3.8). Stored in <dataDir>/labels.json:
// the label definitions (name and icon) and which labels each session has.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_LABELS, LABEL_ICONS, type LabelDef, type LabelIcon } from '../shared/types.ts'

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .slice(0, 40) || 'label'
  )
}

export class LabelStore {
  private file: string
  private defs: LabelDef[]
  private sessions: Record<string, string[]>
  private timer: NodeJS.Timeout | null = null

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'labels.json')
    let raw: any = null
    try {
      raw = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : null
    } catch {}
    this.defs = Array.isArray(raw?.labels)
      ? raw.labels.filter((d: any) => typeof d?.id === 'string' && typeof d.name === 'string').map((d: any) => ({ id: d.id, name: d.name, icon: LABEL_ICONS.includes(d.icon) ? d.icon : 'bookmark' }))
      : DEFAULT_LABELS.map((d) => ({ ...d }))
    this.sessions = raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
  }

  list(): LabelDef[] {
    return this.defs
  }

  /** The session's label ids, in the order of the definitions. */
  of(sessionId: string): string[] {
    const ids = this.sessions[sessionId]
    if (!ids?.length) return []
    return this.defs.filter((d) => ids.includes(d.id)).map((d) => d.id)
  }

  set(sessionId: string, labelId: string, on: boolean): void {
    if (!this.defs.some((d) => d.id === labelId)) return
    const ids = new Set(this.sessions[sessionId] ?? [])
    if (on) ids.add(labelId)
    else ids.delete(labelId)
    if (ids.size) this.sessions[sessionId] = [...ids]
    else delete this.sessions[sessionId]
    this.schedule()
  }

  /** Adds a label, or returns the existing one with the same name (ignoring case). */
  add(name: string, icon: LabelIcon): LabelDef {
    const clean = name.trim().slice(0, 40)
    const existing = this.defs.find((d) => d.name.toLowerCase() === clean.toLowerCase())
    if (existing) return existing
    let id = slug(clean)
    for (let n = 2; this.defs.some((d) => d.id === id); n++) id = `${slug(clean)}-${n}`
    const def: LabelDef = { id, name: clean, icon: LABEL_ICONS.includes(icon) ? icon : 'bookmark' }
    this.defs.push(def)
    this.schedule()
    return def
  }

  /** Deletes the label and takes it off every session. Returns the ids of the sessions that had it. */
  remove(labelId: string): string[] {
    this.defs = this.defs.filter((d) => d.id !== labelId)
    const affected: string[] = []
    for (const [sid, ids] of Object.entries(this.sessions)) {
      if (!ids.includes(labelId)) continue
      affected.push(sid)
      const rest = ids.filter((x) => x !== labelId)
      if (rest.length) this.sessions[sid] = rest
      else delete this.sessions[sid]
    }
    this.schedule()
    return affected
  }

  private schedule(): void {
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 500)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(this.file + '.tmp', JSON.stringify({ labels: this.defs, sessions: this.sessions }, null, 2) + '\n')
      renameSync(this.file + '.tmp', this.file)
    } catch {}
  }
}
