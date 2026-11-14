import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Work rows', () => {
  it('are styled like the Sessions rows', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../src/renderer/src/styles.css'), 'utf8')
    expect(css).toMatch(/\.work-item\.selected\s*\{\s*background:\s*var\(--bg-selected\);/)
    expect(css).not.toMatch(/\.work-item:hover/)
    expect(css).toMatch(/\.work-item\s*\{[^}]*cursor:\s*pointer;/)
  })
})
