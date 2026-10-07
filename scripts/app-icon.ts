// Writes build/icon.png, the icon electron-builder puts on the .exe and installer.
// It is the same drawing the running app uses (src/main/icon.ts). Run by `npm run dist`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { drawAppIcon } from '../src/main/icon.ts'

const file = path.resolve('build', 'icon.png')
mkdirSync(path.dirname(file), { recursive: true })
writeFileSync(file, drawAppIcon(256))
console.log(`Wrote ${file}`)
