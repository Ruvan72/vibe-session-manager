// Runs electron-vite without ELECTRON_RUN_AS_NODE. VS Code's extension host sets it (so terminals
// started by Claude Code inherit it), and it makes Electron start as plain Node.
const { spawnSync } = require('node:child_process')
const path = require('node:path')

delete process.env.ELECTRON_RUN_AS_NODE
const bin = path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(r.status ?? 1)
