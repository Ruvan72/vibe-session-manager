// The title of the window the user is looking at (the foreground window), so the finish sound can stay
// quiet when the session's own window is in front. Windows only; elsewhere it returns null.

import { execFile } from 'node:child_process'

const SCRIPT = `
Add-Type -Namespace Vsm -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
'@
$b = New-Object System.Text.StringBuilder 512
[void][Vsm.W]::GetWindowText([Vsm.W]::GetForegroundWindow(), $b, 512)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$b.ToString()
`
const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64')

/** About a second on Windows: PowerShell has to start and compile the declaration. */
export function foregroundWindowTitle(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
      { windowsHide: true, timeout: 4000, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout.trim() || null)
    )
  })
}

/**
 * Whether a window with this title shows the session: a VS Code / Cursor window on one of its folder
 * names, or the Codex app for threads started there.
 */
export function titleShowsSession(title: string, folderNames: string[], codexApp: boolean): boolean {
  if (codexApp) return /^(Codex|ChatGPT)\b/.test(title)
  if (!/Visual Studio Code|Cursor/.test(title)) return false
  const parts = title.split(/ [-–—] /).map((p) => p.replace(/\s*\(Workspace\)$/, '').trim().toLowerCase())
  return folderNames.some((n) => n && parts.includes(n.toLowerCase()))
}
