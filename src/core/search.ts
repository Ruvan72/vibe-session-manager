// Free-text search over titles, repo/worktree/branch names, folders and the conversation:
// prompts, replies and pasted text (spec 3.5). Tool calls and their output are not searched.

import type { SearchHit } from '../shared/types.ts'

export interface SearchDoc {
  id: string
  /** Fields shown in the list; a match here needs no snippet. */
  meta: string[]
  /** Conversation text: the prompts, then replies and pasted text. Both parts only grow, so the count changes whenever text is added. */
  texts: string[]
}

interface Text {
  raw: string
  /** Same string as raw when it has no capitals, so it is not stored twice. */
  lower: string
}

interface Indexed {
  sig: string
  meta: string
  texts: Text[]
}

export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

function snippet(raw: string, at: number, len: number, width = 60): string {
  const start = Math.max(0, at - width)
  const end = Math.min(raw.length, at + len + width)
  const body = raw.slice(start, end).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + body + (end < raw.length ? '…' : '')
}

function toText(raw: string): Text {
  const lower = raw.toLowerCase()
  return { raw, lower: lower === raw ? raw : lower }
}

export class SearchIndex {
  private docs = new Map<string, Indexed>()

  /** Returns true if the searchable content changed. Texts only grow, so count + last text identify them. */
  set(doc: SearchDoc): boolean {
    const meta = doc.meta.join('\n')
    const sig = `${meta}\0${doc.texts.length}\0${doc.texts[doc.texts.length - 1] ?? ''}`
    const prev = this.docs.get(doc.id)
    if (prev?.sig === sig) return false
    // Reuse the lowercase copies of texts that were already indexed; only new texts are lowercased.
    const known = new Map(prev?.texts.map((t) => [t.raw, t]))
    this.docs.set(doc.id, { sig, meta: meta.toLowerCase(), texts: doc.texts.map((raw) => known.get(raw) ?? toText(raw)) })
    return true
  }

  delete(id: string): boolean {
    return this.docs.delete(id)
  }

  /** Every token must occur somewhere in the session, in any order. */
  search(query: string): SearchHit[] {
    const tokens = tokenize(query)
    if (!tokens.length) return []
    const hits: SearchHit[] = []
    for (const [id, d] of this.docs) {
      let textHit: { raw: string; at: number; len: number } | null = null
      let all = true
      for (const tok of tokens) {
        if (d.meta.includes(tok)) continue
        const t = d.texts.find((t) => t.lower.includes(tok))
        if (!t) {
          all = false
          break
        }
        // Lowercasing can change the length of a few characters; then the raw offsets do not line up.
        textHit ??= { raw: t.raw.length === t.lower.length ? t.raw : t.lower, at: t.lower.indexOf(tok), len: tok.length }
      }
      if (all) hits.push({ id, snippet: textHit ? snippet(textHit.raw, textHit.at, textHit.len) : null })
    }
    return hits
  }
}
