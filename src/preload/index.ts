import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '../shared/api.ts'

function listen<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => cb(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api: Api = {
  getSnapshot: () => ipcRenderer.invoke('get-snapshot'),
  onSnapshot: (cb) => listen('snapshot', cb),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  onUsage: (cb) => listen('usage', cb),
  refreshUsage: () => ipcRenderer.invoke('refresh-usage'),
  search: (q) => ipcRenderer.invoke('search', q),
  jump: (id) => ipcRenderer.invoke('jump', id),
  markSeen: (id) => ipcRenderer.invoke('mark-seen', id),
  markUnread: (id) => ipcRenderer.invoke('mark-unread', id),
  setHidden: (id, hidden) => ipcRenderer.invoke('set-hidden', id, hidden),
  rename: (id, title) => ipcRenderer.invoke('rename', id, title),
  setLabel: (id, labelId, on) => ipcRenderer.invoke('set-label', id, labelId, on),
  addLabel: (id, name, icon) => ipcRenderer.invoke('add-label', id, name, icon),
  removeLabel: (labelId) => ipcRenderer.invoke('remove-label', labelId),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  installHooks: () => ipcRenderer.invoke('install-hooks'),
  uninstallHooks: () => ipcRenderer.invoke('uninstall-hooks'),
  hide: () => ipcRenderer.invoke('hide'),
  minimize: () => ipcRenderer.invoke('minimize'),
  getTimeDays: () => ipcRenderer.invoke('time-days'),
  getTimeDay: (date) => ipcRenderer.invoke('time-day', date),
  openTimeFolder: () => ipcRenderer.invoke('open-time-folder'),
  getArchiveStatus: () => ipcRenderer.invoke('archive-status'),
  onArchiveStatus: (cb) => listen('archive-status', cb),
  searchArchive: (q) => ipcRenderer.invoke('archive-search', q),
  readArchive: (id) => ipcRenderer.invoke('archive-read', id),
  openArchived: (id) => ipcRenderer.invoke('archive-open', id),
  revealArchived: (id) => ipcRenderer.invoke('archive-reveal', id),
  openArchiveFolder: () => ipcRenderer.invoke('archive-folder'),
  openLink: (url) => ipcRenderer.invoke('open-link', url),
  onFocusSearch: (cb) => listen('focus-search', cb),
  onToast: (cb) => listen('toast', cb),
  onPing: (cb) => listen('ping', cb),
  onDebug: (cb) => listen('debug', cb)
}

contextBridge.exposeInMainWorld('api', api)
