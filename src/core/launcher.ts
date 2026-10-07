// Jumps to a session: focus (or open) the editor window for its folder, then open the session there (spec 5.4).
// The "open session" step is a separate dependency so it can later be replaced by a companion extension.

import { spawn } from 'node:child_process'
import type { AppSettings, JumpResult, SessionView } from '../shared/types.ts'

export interface LaunchDeps {
  /** Runs the editor CLI with a folder or workspace file. Resolves when the CLI has exited. */
  runEditor(command: string, target: string): Promise<void>
  /** What to open for the session's folder so an existing window is reused (see workspace.ts). Default: the folder. */
  editorTarget?(homeDir: string): string
  openUri(uri: string): Promise<void>
  copyText(text: string): void
  delay(ms: number): Promise<void>
}

export function resumeCommand(s: Pick<SessionView, 'id' | 'agent'>): string {
  return s.agent === 'codex' ? `codex resume ${s.id}` : `claude --resume ${s.id}`
}

export function sessionUri(scheme: string, sessionId: string): string {
  return `${scheme}://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`
}

/** The Codex VS Code extension (openai.chatgpt) routes /local/<threadId> to that conversation. */
export function codexEditorUri(scheme: string, threadId: string): string {
  return `${scheme}://openai.chatgpt/local/${encodeURIComponent(threadId)}`
}

/** Opens the thread in the Codex desktop app. */
export function codexAppUri(threadId: string): string {
  return `codex://threads/${encodeURIComponent(threadId)}`
}

const CODEX_APP = new Set(['codex_work_desktop', 'Codex Desktop'])

/** Sessions started from the editor extension can be opened in the editor; the rest are resumed in a terminal. */
export function opensInEditor(s: Pick<SessionView, 'entrypoint' | 'agent'>): boolean {
  if (s.agent === 'codex') return s.entrypoint === 'codex_vscode'
  return !s.entrypoint || s.entrypoint === 'claude-vscode'
}

export async function jumpToSession(s: SessionView, settings: AppSettings, deps: LaunchDeps): Promise<JumpResult> {
  if (s.agent === 'codex' && s.entrypoint && CODEX_APP.has(s.entrypoint)) {
    try {
      await deps.openUri(codexAppUri(s.id))
      return { ok: true }
    } catch (e: any) {
      deps.copyText(s.id)
      return { ok: false, message: `Could not open the Codex app (${e?.message ?? e}). Thread id copied.` }
    }
  }
  if (!opensInEditor(s)) {
    deps.copyText(resumeCommand(s))
    return { ok: false, message: `Started from ${s.editor}. Resume command copied: ${resumeCommand(s)}` }
  }
  try {
    await deps.runEditor(settings.editorCommand, deps.editorTarget?.(s.homeDir) ?? s.homeDir)
  } catch (e: any) {
    deps.copyText(s.id)
    return { ok: false, message: `Could not run "${settings.editorCommand}": ${e?.message ?? e}. Session id copied.` }
  }
  await deps.delay(settings.launchDelayMs)
  try {
    await deps.openUri(s.agent === 'codex' ? codexEditorUri(settings.uriScheme, s.id) : sessionUri(settings.uriScheme, s.id))
  } catch (e: any) {
    deps.copyText(s.id)
    return { ok: false, message: `Opened the folder, but not the session (${e?.message ?? e}). Session id copied.` }
  }
  return { ok: true }
}

/**
 * The shell command line for Windows. The command is only quoted when it contains spaces: a bare
 * name in quotes ("code") makes cmd.exe resolve %~dp0 inside code.cmd to the current directory,
 * so the batch file cannot find Code.exe.
 */
export function windowsCommandLine(command: string, folder: string): string {
  return `${/\s/.test(command) ? `"${command}"` : command} "${folder}"`
}

/** Default runEditor: on Windows "code" is code.cmd and needs a shell. */
export function runEditorCli(command: string, folder: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  return new Promise((resolve, reject) => {
    const child =
      platform === 'win32'
        ? spawn(windowsCommandLine(command, folder), { shell: true, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        : spawn(command, [folder], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => resolve(), 5000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim().split(/\r?\n/)[0] || `exit code ${code}`))
    })
  })
}
