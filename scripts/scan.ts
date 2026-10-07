// Prints the session list from the real ~/.claude and ~/.codex, like the prototype scanner (spec appendix A).
// C = Claude Code, X = Codex.
// Usage: npm run scan [-- <search words>]
// Uses a temporary copy of the app's seen marks and hook events, so it shows the same lights as
// the app without writing to the app's data dir.
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionStore } from '../src/core/store.ts'

const query = process.argv.slice(2).join(' ')
const appData = process.env.VSM_DATA_DIR ?? path.join(os.homedir(), '.vibe-session-manager')
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'vsm-scan-'))
for (const f of ['state.json', 'events.jsonl']) if (existsSync(path.join(appData, f))) copyFileSync(path.join(appData, f), path.join(dataDir, f))

const store = new SessionStore({
  claudeDir: process.env.VSM_CLAUDE_DIR ?? path.join(os.homedir(), '.claude'),
  codexDir: process.env.VSM_CODEX_DIR ?? path.join(os.homedir(), '.codex'),
  dataDir,
  isAlive: process.env.VSM_ASSUME_ALIVE ? () => true : undefined
})
const t0 = Date.now()
await store.start()
store.stop()
rmSync(dataDir, { recursive: true, force: true })

const snap = store.snapshot()
const hits = query ? new Map(store.search(query).map((h) => [h.id, h.snippet])) : null
const since = Date.now() - 3 * 864e5
const rows = snap.sessions.filter((s) => (hits ? hits.has(s.id) : s.lastActivity >= since))
const icon = { red: 'R', yellow: 'Y', green: 'G', grey: '.' }
const dur = (ms: number) => `${Math.floor(ms / 3600_000)}:${String(Math.round((ms % 3600_000) / 60_000)).padStart(2, '0')}`
for (const s of rows) {
  const when = new Date(s.lastActivity).toISOString().slice(5, 16).replace('T', ' ')
  const wt = s.worktree ? `[${s.worktree}]` : ''
  console.log(
    `${when} ${s.agent === 'codex' ? 'X' : 'C'} ${icon[s.light]}${s.lightGuess ? '?' : ' '} ${s.status.padEnd(6)} ${dur(s.activeMs).padStart(6)} ${(s.repo + wt).slice(0, 40).padEnd(40)} ${(s.branch ?? '').slice(0, 28).padEnd(28)} ${s.title.slice(0, 60)}${s.light !== 'grey' ? '  -- ' + s.reason : ''}${s.error ? '  !! ' + s.error : ''}`
  )
  if (hits?.get(s.id)) console.log(`      ${hits.get(s.id)}`)
}
console.log(`\n${rows.length} shown / ${snap.sessions.length} sessions, hooks: ${snap.hooks}, counts: ${JSON.stringify(snap.counts)}, ${Date.now() - t0} ms`)
