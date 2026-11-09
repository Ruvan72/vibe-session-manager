// Shows conversation text as Markdown. A conversation can hold anything, so nothing here becomes raw
// HTML: the text is parsed to tokens and each token to React elements. HTML in the text is shown as
// text, images are not loaded, and only web links can be followed.

import { marked, type Token, type Tokens } from 'marked'
import { memo, useMemo, type ReactNode } from 'react'
import { highlightParts, isWebLink, turnKind } from './view.ts'

export function Highlighted({ text, re }: { text: string; re: RegExp | null }) {
  return (
    <>
      {highlightParts(text, re).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text))}
    </>
  )
}

interface Ctx {
  re: RegExp | null
  onLink(url: string): void
}

function inlines(tokens: Token[] | undefined, ctx: Ctx): ReactNode {
  return tokens?.map((t, i) => <Inline key={i} t={t} ctx={ctx} />)
}

function Inline({ t, ctx }: { t: Token; ctx: Ctx }) {
  switch (t.type) {
    case 'strong':
      return <strong>{inlines((t as Tokens.Strong).tokens, ctx)}</strong>
    case 'em':
      return <em>{inlines((t as Tokens.Em).tokens, ctx)}</em>
    case 'del':
      return <del>{inlines((t as Tokens.Del).tokens, ctx)}</del>
    case 'codespan':
      return (
        <code>
          <Highlighted text={(t as Tokens.Codespan).text} re={ctx.re} />
        </code>
      )
    case 'br':
      return <br />
    case 'link': {
      const link = t as Tokens.Link
      const text = inlines(link.tokens, ctx)
      if (!isWebLink(link.href)) return <>{text}</>
      return (
        <a
          href={link.href}
          title={link.href}
          onClick={(e) => {
            e.preventDefault()
            ctx.onLink(link.href)
          }}
        >
          {text}
        </a>
      )
    }
    case 'image':
      return <Highlighted text={`[image: ${(t as Tokens.Image).text || (t as Tokens.Image).href}]`} re={ctx.re} />
    case 'checkbox':
      return <input type="checkbox" checked={!!(t as { checked?: boolean }).checked} disabled readOnly />
    case 'text':
      if ('tokens' in t && t.tokens?.length) return <>{inlines(t.tokens, ctx)}</>
      return <Highlighted text={(t as Tokens.Text).text} re={ctx.re} />
    default:
      // HTML and anything this version does not know: the text as it was written.
      return <Highlighted text={'text' in t && typeof t.text === 'string' ? t.text : t.raw} re={ctx.re} />
  }
}

function blocks(tokens: Token[] | undefined, ctx: Ctx): ReactNode {
  return tokens?.map((t, i) => <Block key={i} t={t} ctx={ctx} />)
}

function Block({ t, ctx }: { t: Token; ctx: Ctx }) {
  switch (t.type) {
    case 'space':
      return null
    case 'heading': {
      const h = t as Tokens.Heading
      const kind = h.depth === 2 ? turnKind(h.text) : null
      if (kind) {
        return (
          <h2 className={`turn turn-${kind}`}>
            <Highlighted text={h.text} re={ctx.re} />
          </h2>
        )
      }
      const Tag = `h${Math.min(h.depth + 2, 6)}` as 'h3'
      return <Tag>{inlines(h.tokens, ctx)}</Tag>
    }
    case 'paragraph':
      return <p>{inlines((t as Tokens.Paragraph).tokens, ctx)}</p>
    case 'code':
      return (
        <pre>
          <code>
            <Highlighted text={(t as Tokens.Code).text} re={ctx.re} />
          </code>
        </pre>
      )
    case 'blockquote':
      return <blockquote>{blocks((t as Tokens.Blockquote).tokens, ctx)}</blockquote>
    case 'list': {
      const list = t as Tokens.List
      const items = list.items.map((item, i) => <li key={i}>{blocks(item.tokens, ctx)}</li>)
      return list.ordered ? <ol start={Number(list.start) || 1}>{items}</ol> : <ul>{items}</ul>
    }
    case 'table': {
      const table = t as Tokens.Table
      return (
        <div className="md-table">
          <table>
            <thead>
              <tr>
                {table.header.map((c, i) => (
                  <th key={i}>{inlines(c.tokens, ctx)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i}>{inlines(c.tokens, ctx)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'hr':
      return <hr />
    case 'text':
    case 'checkbox':
      return <Inline t={t} ctx={ctx} />
    case 'html':
      return (
        <p className="md-html">
          <Highlighted text={t.raw.trim()} re={ctx.re} />
        </p>
      )
    default:
      return (
        <p>
          <Highlighted text={t.raw} re={ctx.re} />
        </p>
      )
  }
}

/** The whole document. Parsing only runs when the text changes; a new search only highlights again. */
export const Markdown = memo(function Markdown({ source, re, onLink }: { source: string; re: RegExp | null; onLink(url: string): void }) {
  const tokens = useMemo(() => marked.lexer(source, { gfm: true, breaks: true }), [source])
  return <>{blocks(tokens, { re, onLink })}</>
})
