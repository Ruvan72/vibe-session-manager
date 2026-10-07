// Electron main process: tray, list window, global shortcuts, notifications, and IPC to the renderer.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  shell,
  Tray
} from 'electron'
import {
  adoptLegacyDataDir,
  HOOK_EVENTS,
  installHooks,
  jumpToSession,
  loadSettings,
  editorTarget,
  readEditorState,
  runEditorCli,
  saveSettings,
  SessionStore,
  uninstallHooks,
  upgradeLegacyHooks
} from '../core/index.ts'
import type { DebugActions, SettingsInfo } from '../shared/api.ts'
import type { AppSettings, JumpResult, LabelIcon, SessionView, Snapshot } from '../shared/types.ts'
import { foregroundWindowTitle, titleShowsSession } from './foreground.ts'
import { drawAppIcon, drawTrayIcon, SPINNER_FRAMES } from './icon.ts'

const APP_NAME = 'Vibe Session Manager'
const claudeDir = process.env.VSM_CLAUDE_DIR ?? path.join(os.homedir(), '.claude')
const codexDir = process.env.VSM_CODEX_DIR ?? path.join(os.homedir(), '.codex')
const dataDir = process.env.VSM_DATA_DIR ?? path.join(os.homedir(), '.vibe-session-manager')
const screenshotPath = process.env.VSM_SCREENSHOT
const HIDDEN_ARG = '--hidden'
const debugActions: DebugActions | null = process.env.VSM_DEBUG ? JSON.parse(process.env.VSM_DEBUG) : null

/** The data dir under the app's earlier name, AI Dev Session Manager. */
const LEGACY_DATA_DIR = path.join(os.homedir(), '.ai-dev-session-manager')
if (!process.env.VSM_DATA_DIR) adoptLegacyDataDir(LEGACY_DATA_DIR, dataDir)

let settings: AppSettings = loadSettings(dataDir)
let store: SessionStore
let tray: Tray | null = null
let win: BrowserWindow | null = null
let shortcutErrors: string[] = []
let lastUrgentId: string | null = null
let quitting = false
const liveNotifications = new Set<Notification>()

// Only one instance runs; a second launch just opens the first one's window and quits.
if (screenshotPath || app.requestSingleInstanceLock()) start()
else app.quit()

function start(): void {
  app.setAppUserModelId('com.switch2ai.vibe-session-manager')
  app.on('second-instance', () => showWindow({ focusSearch: true, nearCursor: true }))
  // A tray app keeps running without windows.
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => {
    setWorkingAnimation(false)
    globalShortcut.unregisterAll()
    store?.stop()
  })
  registerIpc()

  app.whenReady().then(async () => {
    app.dock?.hide()
    if (process.env.VSM_THEME === 'dark' || process.env.VSM_THEME === 'light') nativeTheme.themeSource = process.env.VSM_THEME
    if (!process.env.VSM_DATA_DIR) await upgradeHooksFromLegacy()
    store = new SessionStore({
      claudeDir,
      codexDir,
      dataDir,
      idleGapMs: settings.idleGapMinutes * 60_000,
      isAlive: process.env.VSM_ASSUME_ALIVE ? () => true : undefined
    })
    store.on('change', onSnapshot)
    store.on('waiting', (s) => notify(s, s.reason || 'Waiting for you'))
    store.on('finished', (s) => {
      if (settings.notifyOnYellow) notify(s, 'Finished a turn')
      void pingFinished(s)
    })

    createWindow()
    if (!screenshotPath) {
      createTray()
      registerShortcuts()
      // Started by hand: show the list, so it is clear the app is running. Started at login: stay in the tray.
      if (!process.argv.includes(HIDDEN_ARG)) win?.once('ready-to-show', () => showWindow({ focusSearch: true }))
    }
    await store.start()
    onSnapshot(store.snapshot())
    if (screenshotPath) await takeScreenshot(screenshotPath)
  })
}

// ---------- window ----------

const boundsFile = path.join(dataDir, 'window.json')

/** The last window position and size, if it is still on a connected screen. */
function savedBounds(): Electron.Rectangle | null {
  try {
    const b = JSON.parse(readFileSync(boundsFile, 'utf8'))
    if (![b.x, b.y, b.width, b.height].every((v) => typeof v === 'number')) return null
    const visible = screen.getAllDisplays().some(({ workArea: wa }) => b.x + 40 < wa.x + wa.width && b.x + b.width - 40 > wa.x && b.y >= wa.y - 8 && b.y + 40 < wa.y + wa.height)
    return visible ? b : null
  } catch {
    return null
  }
}

let saveBoundsTimer: NodeJS.Timeout | null = null
function saveBounds(): void {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer)
  saveBoundsTimer = setTimeout(() => {
    if (!win || win.isMinimized() || screenshotPath) return
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(boundsFile, JSON.stringify(win.getNormalBounds()))
    } catch {}
  }, 500)
}

/** Whether the window has a position yet; until then it opens next to the tray icon. */
let placed = false

function createWindow(): void {
  const bounds = screenshotPath ? null : savedBounds()
  placed = !!bounds
  win = new BrowserWindow({
    width: bounds?.width ?? 480,
    height: bounds?.height ?? 660,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 360,
    minHeight: 320,
    show: false,
    frame: false,
    title: APP_NAME,
    icon: nativeImage.createFromBuffer(drawAppIcon(256)),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171b' : '#ffffff',
    // The finish sound must play while the window is hidden in the tray.
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false }
  })
  // A normal window (taskbar, Alt+Tab). Closing it only hides it to the tray; Quit is in the tray menu.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('show', applyProgress)
  win.on('moved', saveBounds)
  win.on('resized', saveBounds)
  win.webContents.on('did-finish-load', () => win?.webContents.setZoomLevel(settings.zoomLevel))
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return
    const k = input.key
    if (k === '+' || k === '=' || k === 'Add') setZoom(settings.zoomLevel + ZOOM_STEP)
    else if (k === '-' || k === '_' || k === 'Subtract') setZoom(settings.zoomLevel - ZOOM_STEP)
    else if (k === '0' && !input.shift) setZoom(0)
    else return
    e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

// Text size, like an editor: Ctrl+plus, Ctrl+minus, Ctrl+0. A step of 0.5 is about 10 %.
const ZOOM_STEP = 0.5
const ZOOM_MIN = -3
const ZOOM_MAX = 5

function setZoom(level: number): void {
  const zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level))
  win?.webContents.setZoomLevel(zoomLevel)
  win?.webContents.send('toast', `Text size ${Math.round(Math.pow(1.2, zoomLevel) * 100)} %`)
  if (zoomLevel === settings.zoomLevel) return
  settings = { ...settings, zoomLevel }
  saveSettings(dataDir, settings)
}

/** Opens next to the tray icon (or centred at the cursor) the first time, later where the user left it. */
function placeWindow(nearCursor: boolean): void {
  if (!win) return
  const [w, h] = win.getSize()
  const tb = tray?.getBounds()
  const useTray = !nearCursor && tb && tb.width > 0
  const display = screen.getDisplayNearestPoint(useTray ? { x: tb.x, y: tb.y } : screen.getCursorScreenPoint())
  const wa = display.workArea
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  if (useTray) {
    const x = clamp(Math.round(tb.x + tb.width / 2 - w / 2), wa.x + 8, wa.x + wa.width - w - 8)
    win.setPosition(x, tb.y > wa.y + wa.height / 2 ? wa.y + wa.height - h - 8 : wa.y + 8)
  } else {
    win.setPosition(Math.round(wa.x + (wa.width - w) / 2), Math.round(wa.y + wa.height * 0.18))
  }
  placed = true
}

function showWindow(opts: { focusSearch?: boolean; nearCursor?: boolean } = {}): void {
  if (!win) return
  if (!placed) placeWindow(!!opts.nearCursor)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (opts.focusSearch) win.webContents.send('focus-search')
}

function toggleWindow(): void {
  if (win?.isVisible() && win.isFocused()) win.minimize()
  else showWindow({ focusSearch: true })
}

async function takeScreenshot(file: string): Promise<void> {
  if (!win) return
  win.center()
  win.showInactive()
  await new Promise((r) => setTimeout(r, 1200))
  if (debugActions) win.webContents.send('debug', debugActions)
  await new Promise((r) => setTimeout(r, 1500))
  const img = await win.webContents.capturePage()
  writeFileSync(file, img.toPNG())
  app.exit(0)
}

// ---------- tray ----------

const trayImages = new Map<string, Electron.NativeImage>()

/** spinFrame: draw the turning "working" ring at this frame; null for the still icon. */
function trayImage(snap: Snapshot, spinFrame: number | null = null): Electron.NativeImage {
  const count = snap.counts.red + snap.counts.yellow
  const color = snap.counts.red ? 'red' : snap.counts.yellow ? 'yellow' : snap.counts.green ? 'green' : 'grey'
  const key = `${count}|${color}|${spinFrame}`
  let img = trayImages.get(key)
  if (!img) {
    img = nativeImage.createFromBuffer(drawTrayIcon(16, count, color, spinFrame), { scaleFactor: 1 })
    img.addRepresentation({ scaleFactor: 2, buffer: drawTrayIcon(32, count, color, spinFrame) })
    if (trayImages.size > 200) trayImages.clear()
    trayImages.set(key, img)
  }
  return img
}

// While a session works, the tray icon turns (one turn per second) and the taskbar button shows
// Windows' own indeterminate progress animation.
let lastSnap: Snapshot | null = null
let spinFrame = 0
let spinTimer: NodeJS.Timeout | null = null
let showingProgress = false

function updateTrayImage(): void {
  if (tray && lastSnap) tray.setImage(trayImage(lastSnap, spinTimer ? spinFrame : null))
}

function setWorkingAnimation(working: boolean): void {
  if (working && !spinTimer) {
    spinTimer = setInterval(() => {
      spinFrame = (spinFrame + 1) % SPINNER_FRAMES
      updateTrayImage()
    }, 1000 / SPINNER_FRAMES)
  } else if (!working && spinTimer) {
    clearInterval(spinTimer)
    spinTimer = null
  }
  if (working !== showingProgress) {
    showingProgress = working
    applyProgress()
  }
}

// Windows drops the progress when the taskbar button goes away: while the window is hidden in the
// tray, or before it is first shown. So it is applied again each time the window is shown.
function applyProgress(): void {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return
  win.setProgressBar(showingProgress ? 1 : -1, { mode: showingProgress ? 'indeterminate' : 'none' })
}

function createTray(): void {
  tray = new Tray(trayImage(store.snapshot()))
  tray.on('click', toggleWindow)
  tray.on('right-click', () => tray?.popUpContextMenu(trayMenu()))
}

function trayMenu(): Menu {
  const hooks = store.snapshot().hooks
  return Menu.buildFromTemplate([
    { label: 'Open', click: () => showWindow({ focusSearch: true }) },
    { label: 'Jump to most urgent session', accelerator: settings.shortcuts.jumpUrgent, click: () => void jumpUrgent() },
    { type: 'separator' },
    hooks === 'installed'
      ? { label: 'Remove Claude Code hooks…', click: () => void confirmUninstall() }
      : { label: 'Install Claude Code hooks…', click: () => void confirmInstall() },
    { label: 'Start at login', type: 'checkbox', checked: app.getLoginItemSettings(loginItem()).openAtLogin, click: (i) => setOpenAtLogin(i.checked) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
}

function onSnapshot(snap: Snapshot): void {
  lastSnap = snap
  if (!screenshotPath) setWorkingAnimation(snap.counts.green > 0)
  if (tray) {
    updateTrayImage()
    const parts = [
      snap.counts.red && `${snap.counts.red} waiting`,
      snap.counts.yellow && `${snap.counts.yellow} unread`,
      snap.counts.green && `${snap.counts.green} working`
    ].filter(Boolean)
    tray.setToolTip(`${APP_NAME}${parts.length ? ' – ' + parts.join(', ') : ''}`)
  }
  if (win && process.platform === 'win32') {
    // Badge on the taskbar button, like the tray icon.
    const count = snap.counts.red + snap.counts.yellow
    win.setOverlayIcon(
      count ? nativeImage.createFromBuffer(drawTrayIcon(32, count, snap.counts.red ? 'red' : 'yellow')) : null,
      count ? `${count} sessions need you` : ''
    )
  }
  win?.webContents.send('snapshot', snap)
}

// ---------- notifications ----------

function sessionLabel(s: SessionView): string {
  return `${s.repo}${s.worktree ? ' · ' + s.worktree : s.branch ? ' · ' + s.branch : ''}`
}

function notify(s: SessionView, body: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: `${s.title}`, subtitle: sessionLabel(s), body: `${sessionLabel(s)}\n${body}${s.lightGuess ? ' (probably)' : ''}` })
  liveNotifications.add(n)
  const drop = () => liveNotifications.delete(n)
  n.on('click', () => {
    drop()
    void jump(s.id)
  })
  n.on('close', drop)
  n.show()
}

let lastPingAt = 0

/** The finish sound, unless the user is looking at the session's own window. */
async function pingFinished(s: SessionView): Promise<void> {
  if (!settings.soundOnFinish || !win) return
  if (settings.soundOnlyWhenAway) {
    const title = await foregroundWindowTitle()
    const target = editorTarget(s.homeDir, readEditorState(editorStorageFile()))
    const names = [path.basename(s.homeDir), path.basename(target).replace(/\.code-workspace$/, '')]
    if (title && titleShowsSession(title, names, s.agent === 'codex' && s.editor === 'Codex app')) return
  }
  // Several sessions finishing together make one sound.
  if (Date.now() - lastPingAt < 1500) return
  lastPingAt = Date.now()
  win.webContents.send('ping')
}

function toast(message: string): void {
  if (win?.isVisible() && !win.isMinimized()) win.webContents.send('toast', message)
  else if (Notification.isSupported()) new Notification({ title: APP_NAME, body: message }).show()
}

// ---------- jumping ----------

async function jump(id: string): Promise<JumpResult> {
  const s = store.get(id)
  if (!s) return { ok: false, message: 'Session not found' }
  const res = await jumpToSession(s, settings, {
    runEditor: runEditorCli,
    editorTarget: (homeDir) => editorTarget(homeDir, readEditorState(editorStorageFile())),
    openUri: (uri) => shell.openExternal(uri),
    copyText: (t) => clipboard.writeText(t),
    delay: (ms) => new Promise((r) => setTimeout(r, ms))
  })
  // Jumping to a finished turn means the user is now looking at it. A red session stays
  // red until it is actually answered.
  if (s.light === 'yellow') store.markSeen(id)
  if (!res.ok && res.message) toast(res.message)
  return res
}

/** VS Code's (or Cursor's) storage.json, which lists the open windows. */
function editorStorageFile(): string {
  const product = /cursor/i.test(settings.editorCommand) ? 'Cursor' : 'Code'
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'))
  return path.join(base, product, 'User', 'globalStorage', 'storage.json')
}

async function jumpUrgent(): Promise<void> {
  const queue = store.urgent()
  if (!queue.length) {
    toast('Nothing is waiting for you.')
    return
  }
  const i = queue.findIndex((s) => s.id === lastUrgentId)
  const next = queue[(i + 1) % queue.length]
  lastUrgentId = next.id
  await jump(next.id)
}

// ---------- shortcuts ----------

function registerShortcuts(): void {
  globalShortcut.unregisterAll()
  shortcutErrors = []
  const bind = (accel: string, fn: () => void) => {
    if (!accel) return
    try {
      if (!globalShortcut.register(accel, fn)) shortcutErrors.push(accel)
    } catch {
      shortcutErrors.push(accel)
    }
  }
  bind(settings.shortcuts.openList, () => showWindow({ focusSearch: true, nearCursor: true }))
  bind(settings.shortcuts.jumpUrgent, () => void jumpUrgent())
}

// ---------- hooks ----------

/** Command that runs the hook script: Node if it is on PATH, otherwise this app's own binary in Node mode. */
function hookRunner(): string {
  const r = spawnSync('node', ['--version'], { shell: true, encoding: 'utf8', windowsHide: true, timeout: 5000 })
  if (r.status === 0) return 'node'
  return `ELECTRON_RUN_AS_NODE=1 "${process.execPath.replace(/\\/g, '/')}"`
}

/**
 * Hooks installed under the app's earlier name run the hook script in the old data dir. They were approved
 * then, so they are moved over without asking. On failure they keep writing to the old dir, and the
 * next start tries again.
 */
async function upgradeHooksFromLegacy(): Promise<void> {
  try {
    if (await upgradeLegacyHooks(path.join(claudeDir, 'settings.json'), dataDir, hookRunner)) console.log('Moved Claude Code hooks to', dataDir)
  } catch (e) {
    console.error('Could not move Claude Code hooks from', LEGACY_DATA_DIR, e)
  }
}

async function confirmInstall(): Promise<void> {
  const settingsPath = path.join(claudeDir, 'settings.json')
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Install Claude Code hooks',
    message: 'Install hooks for reliable attention status?',
    detail:
      `This adds a hook for ${HOOK_EVENTS.join(', ')} to\n${settingsPath}\n\n` +
      `Existing settings and hooks are kept, and a backup is saved as settings.json.vsm-backup. ` +
      `The hook writes only session id, event name, time and notification text to ${path.join(dataDir, 'events.jsonl')}. It never records prompts.\n\n` +
      `Sessions that are already running may need a restart before their status is reliable. You can remove the hooks again from the tray menu or settings.`
  })
  if (response !== 0) return
  try {
    await installHooks(settingsPath, dataDir, hookRunner())
  } catch (e: any) {
    dialog.showErrorBox('Could not install hooks', String(e?.message ?? e))
  }
  await store.refreshHooksStatus()
}

async function confirmUninstall(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Remove', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Remove the hooks from Claude Code settings?',
    detail: 'Other hooks and settings are left untouched. Attention status will be guessed from transcripts again.'
  })
  if (response !== 0) return
  try {
    await uninstallHooks(path.join(claudeDir, 'settings.json'))
  } catch (e: any) {
    dialog.showErrorBox('Could not remove hooks', String(e?.message ?? e))
  }
  await store.refreshHooksStatus()
}

/** Unpackaged, Electron needs the app folder as argument; it then runs the last build (out/). */
function loginArgs(): string[] {
  return app.isPackaged ? [HIDDEN_ARG] : [app.getAppPath(), HIDDEN_ARG]
}

/** The portable .exe unpacks itself to a temp folder on every start; login must run the .exe itself. */
function loginItem(): { args: string[]; path?: string } {
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE
  return portableExe ? { args: loginArgs(), path: portableExe } : { args: loginArgs() }
}

function setOpenAtLogin(openAtLogin: boolean): void {
  app.setLoginItemSettings({ openAtLogin, ...loginItem() })
}

// ---------- IPC ----------

function settingsInfo(): SettingsInfo {
  return { settings, openAtLogin: app.getLoginItemSettings(loginItem()).openAtLogin, shortcutErrors, version: app.getVersion(), dataDir }
}

function registerIpc(): void {
  ipcMain.handle('get-snapshot', () => store.snapshot())
  ipcMain.handle('search', (_e, q: string) => store.search(String(q)))
  ipcMain.handle('jump', (_e, id: string) => jump(id))
  ipcMain.handle('mark-seen', (_e, id: string) => store.markSeen(id))
  ipcMain.handle('mark-unread', (_e, id: string) => store.markUnread(id))
  ipcMain.handle('set-hidden', (_e, id: string, hidden: boolean) => store.setHidden(String(id), !!hidden))
  ipcMain.handle('rename', (_e, id: string, title: string) => store.rename(String(id), String(title)))
  ipcMain.handle('set-label', (_e, id: string, labelId: string, on: boolean) => store.setLabel(String(id), String(labelId), !!on))
  ipcMain.handle('add-label', (_e, id: string, name: string, icon: LabelIcon) => store.addLabel(String(id), String(name), icon))
  ipcMain.handle('remove-label', (_e, labelId: string) => store.removeLabel(String(labelId)))
  ipcMain.handle('copy-text', (_e, text: string) => clipboard.writeText(String(text)))
  ipcMain.handle('hide', () => win?.hide())
  ipcMain.handle('minimize', () => win?.minimize())
  ipcMain.handle('get-settings', () => settingsInfo())
  ipcMain.handle('set-settings', (_e, patch: Partial<AppSettings> & { openAtLogin?: boolean }) => {
    const { openAtLogin, ...rest } = patch
    if (typeof openAtLogin === 'boolean') setOpenAtLogin(openAtLogin)
    settings = { ...settings, ...rest, shortcuts: { ...settings.shortcuts, ...(rest.shortcuts ?? {}) } }
    saveSettings(dataDir, settings)
    store.setIdleGap(settings.idleGapMinutes * 60_000)
    if (!screenshotPath) registerShortcuts()
    return settingsInfo()
  })
  ipcMain.handle('install-hooks', async () => {
    await confirmInstall()
    return store.snapshot().hooks
  })
  ipcMain.handle('uninstall-hooks', async () => {
    await confirmUninstall()
    return store.snapshot().hooks
  })
  ipcMain.handle('time-days', () => store.timeDays())
  ipcMain.handle('time-day', (_e, date: string) => store.timeDay(String(date)))
  ipcMain.handle('open-time-folder', async () => {
    store.timelog.flush()
    await shell.openPath(store.timelog.dir)
  })
}
