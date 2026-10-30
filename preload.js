'use strict';
/**
 * preload：渲染进程唯一的能力入口。
 * contextIsolation = true / nodeIntegration = false，
 * 渲染层拿不到 require / fs / child_process，只能调用下面这些白名单方法。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('nest', {
  /* ---- 数据 ---- */
  init: () => invoke('nest:init'),
  rescan: () => invoke('nest:rescan'),
  saveConfig: (patch) => invoke('nest:save-config', patch),

  /* ---- 系统调用 ---- */
  launch: (item) => invoke('nest:launch', item),
  reveal: (item) => invoke('nest:reveal', item),
  pickApps: () => invoke('nest:pick-apps'),
  scanApps: () => invoke('nest:scan-apps'),
  listWallpapers: () => invoke('nest:list-wallpapers'),
  setCardBg: (payload) => invoke('nest:set-card-bg', payload),
  pickBgImage: () => invoke('nest:pick-bg-image'),
  clearCardBg: () => invoke('nest:clear-card-bg'),
  pickFolders: () => invoke('nest:pick-folders'),
  addPaths: (paths) => invoke('nest:add-paths', paths),
  pickIcon: (itemPath) => invoke('nest:pick-icon', itemPath),
  resetIcon: (item) => invoke('nest:reset-icon', item),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  addExtras: (items) => invoke('nest:add-extras', items),
  openPath: (p) => invoke('nest:open-path', p),

  /* ---- 桌面图标显隐 ---- */
  desktopIconsState: () => invoke('nest:desktop-icons-state'),
  toggleDesktopIcons: (hidden) => invoke('nest:toggle-desktop-icons', hidden),

  /* ---- 窗口 ---- */
  backdrop: (refresh) => invoke('nest:backdrop', refresh),
  onBackdropFrame: (cb) => ipcRenderer.on('nest:backdrop-frame', (_e, b64) => cb(b64)),
  asleep: (flag) => invoke('nest:asleep', flag),
  onPrewarm: (cb) => ipcRenderer.on('nest:prewarm', (_e, on) => cb(on)),
  onAcrylic: (cb) => ipcRenderer.on('nest:acrylic', (_e, on) => cb(on)),
  setAlwaysOnTop: (flag) => invoke('nest:set-always-on-top', flag),
  focus: () => invoke('nest:focus'),
  setSize: (width, height) => invoke('nest:set-size', { width, height }),
  setCollapsed: (flag) => invoke('nest:set-collapsed', flag),
  windowAction: (action) => invoke('nest:window', action),
  winState: () => invoke('nest:win-state'),
  startup: (flag) => invoke('nest:startup', flag),
  getStartup: () => invoke('nest:get-startup'),
  resize: (edge, dx, dy) => ipcRenderer.invoke('nest:resize', edge, dx, dy),

  /* ---- 事件 ---- */
  onWinState: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('nest:win-state', handler);
    return () => ipcRenderer.removeListener('nest:win-state', handler);
  }
});