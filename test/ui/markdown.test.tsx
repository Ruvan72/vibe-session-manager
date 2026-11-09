import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../../src/renderer/src/markdown.tsx'
import { formatBytes, highlightParts, highlightRegex, isWebLink, turnKind } from '../../src/renderer/src/view.ts'

const html = (source: string, query = '') => renderToStaticMarkup(<Markdown source={source} re={highlightRegex(query)} onLink={() => {}} />)

describe('highlighting', () => {
  it('marks every word in any case, longest first', () => {
    expect(highlightParts('Merged the MERGE here', highlightRegex('merge merged'))).toEqual([
      { text: 'Merged', hit: true },
      { text: ' the ', hit: false },
      { text: 'MERGE', hit: true },
      { text: ' here', hit: false }
    ])
  })

  it('treats special characters as text', () => {
    expect(highlightParts('a.b axb (c)', highlightRegex('a.b (c)')).filter((p) => p.hit).map((p) => p.text)).toEqual(['a.b', '(c)'])
  })

  it('has nothing to do without a search', () => {
    expect(highlightRegex('  ')).toBeNull()
    expect(highlightParts('text', null)).toEqual([{ text: 'text', hit: false }])
    expect(highlightParts('', highlightRegex('x'))).toEqual([])
  })
})

describe('Markdown', () => {
  it('renders the usual things', () => {
    const out = html('## Claude · 2026-10-01 10:00\n\nSome **bold** and `code`.\n\n- one\n  - nested\n\n1. first\n\n> quote\n\n|a|b|\n|-|-|\n|1|2|\n\n```js\nlet x\n```\n\n---\n\n# Big')
    expect(out).toContain('<h2 class="turn turn-agent">')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<code>code</code>')
    expect(out).toContain('<ul>')
    expect(out).toContain('<ol')
    expect(out).toContain('<blockquote>')
    expect(out).toContain('<td>1</td>')
    expect(out).toContain('<pre><code>let x</code></pre>')
    expect(out).toContain('<hr/>')
    expect(out).toContain('<h3>Big</h3>')
  })

  it('never turns text into HTML or loads anything', () => {
    const out = html('<img src=x onerror="alert(1)">\n\nInline <script>alert(2)</script> text\n\n![pic](https://example.com/track.png)\n\n<iframe src="https://example.com"></iframe>')
    expect(out).not.toMatch(/<img|<script|<iframe|onerror="/)
    expect(out).toContain('&lt;img src=x')
    expect(out).toContain('[image: pic]')
  })

  it('only makes web links clickable', () => {
    const out = html('[good](https://example.com/a) [bad](javascript:alert(1)) [file](file:///c:/x)')
    expect(out).toContain('href="https://example.com/a"')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('file:')
    expect(out).toContain('bad')
    expect(isWebLink('HTTP://x')).toBe(true)
    expect(isWebLink('mailto:x')).toBe(false)
  })

  it('marks matches in text, code and headings', () => {
    const out = html('## You · 2026-10-01 10:00\n\nthe needle\n\n`needle`\n\n```\nneedle\n```\n\n- **needle**\n\n|needle|\n|-|\n|x|', 'NEEDLE')
    expect(out.match(/<mark>needle<\/mark>/g)).toHaveLength(5)
    expect(html('## You · 2026-10-01 10:00', 'you')).toContain('<mark>You</mark>')
  })

  it('tells turns from headings in the text', () => {
    expect(turnKind('You · 2026-10-01 10:00')).toBe('user')
    expect(turnKind('Task for subagent')).toBe('user')
    expect(turnKind('Codex · 2026-10-01 10:00')).toBe('agent')
    expect(turnKind('You and me')).toBeNull()
  })
})

describe('formatBytes', () => {
  it('picks a readable unit', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatBytes(3.5 * 1024 * 1024 * 1024)).toBe('3.5 GB')
  })
})
