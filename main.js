'use strict';
/**
 * DeskNest 主进程
 * ------------------------------------------------------------------
 * 设计原则（性能红线）：
 *  - 无轮询 / 无 fs.watch / 无后台服务 / 不联网
 *  - 图标只在首次扫描时提取，落本地缓存，之后纯复用
 *  - 窗口隐藏时销毁渲染负担（渲染进程内 CSS 动画暂停 + 定时器自停）
 *  - 单实例；托盘常驻，关窗口只隐藏，托盘菜单里"退出"才结束进程
 */

const { app, BrowserWindow, ipcMain, shell, dialog, globalShortcut, screen, protocol, net, Tray, Menu } = require('electron');

// 主进程崩溃要留证据：Electron 默认只弹一个"Error"原生对话框，看不到堆栈
process.on('uncaughtException', (e) => {
  try {
    require('node:fs').writeFileSync(require('node:path').join(app.getPath('userData'), 'main-crash.txt'),
      '[' + new Date().toISOString() + '] uncaughtException\n' + (e && e.stack ? e.stack : String(e)));
  } catch { /* ignore */ }
  console.log('[nest] 主进程异常: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  try {
    require('node:fs').appendFileSync(require('node:path').join(app.getPath('userData'), 'main-crash.txt'),
      '[' + new Date().toISOString() + '] unhandledRejection\n' + (e && e.stack ? e.stack : String(e)) + '\n');
  } catch { /* ignore */ }
  console.log('[nest] 未处理拒绝: ' + (e && e.stack ? e.stack : e));
});
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');

const fsp = fs.promises;

/* 自定义协议：把磁盘上的真实系统图标 PNG（最高 256×256）喂给渲染层。
 * 用协议而不是 dataURL，IPC 负载从几百 KB 降到几 KB，内存也干净。 */
protocol.registerSchemesAsPrivileged([{
  scheme: 'nest-icon',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

/* ---------------------------------------------------------------- 轻量化开关
 * 必须在 app ready 之前设置。目标：少起进程、少留缓存、少做后台活。
 */
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');   // 网络服务并入主进程 → 少一个进程
app.commandLine.appendSwitch('disable-features', [
  'SpareRendererForSitePerProcess',   // 不预热备用渲染进程
  'BackForwardCache',                 // 本工具没有前进后退
  'MediaRouter',                      // 无投屏
  'OptimizationGuideModelDownloading',// 不下载模型
  'AutofillServerCommunication',
  'Translate'
].join(','));
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128');   // 本工具堆很小，卡住 V8 预留，别让它惯性吃内存

// 启动耗时打点（仅在 NEST_TIMING=1 时输出，正常运行零开销）
const T0 = Date.now();
const timing = (label) => {
  if (process.env.NEST_TIMING === '1') console.log(`[timing] ${label} ${Date.now() - T0}ms`);
};

// ---------------------------------------------------------------- 路径与常量
const USER_DATA = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA, 'desknest-config.json');
const FIRST_RUN = !fs.existsSync(CONFIG_FILE);   // 没有配置文件 = 第一次启动，弹一次「安顿好」的询问
const ICON_CACHE_FILE = path.join(USER_DATA, 'desknest-icon-cache.json');
const ICON_DIR = path.join(USER_DATA, 'iconcache');
const EXTRACT_SCRIPT = path.join(__dirname, 'tools', 'icon-extract.ps1');
const SCAN_SCRIPT = path.join(__dirname, 'tools', 'scan-apps.ps1');
const WALLPAPER_SCRIPT = path.join(__dirname, 'tools', 'scan-wallpapers.ps1');
const BG_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);
const BG_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm'
};
const ICON_CACHE_LIMIT = 800;          // 回退用 dataURL 缓存上限
const ICON_SIZE = 'large';             // getFileIcon 回退尺寸
const ICON_REV = 'v3';                 // 图标提取算法版本，改了提取逻辑就 +1（触发一次性重取）

const SHORTCUT = 'Control+Alt+D';

const TYPE = { LNK: 'lnk', URL: 'url', EXE: 'exe', APPFREF: 'appref', DIR: 'folder' };

/** 手动添加的网站条目：path 本身就是网址，不是磁盘文件 */
function isUrlPath(p) {
  return /^https?:\/\//i.test(String(p || ''));
}

let win = null;
let iconCache = { version: 1, entries: {} };   // { key: dataURL }
let iconCacheDirty = false;
let iconCacheTimer = null;
let quitting = false;

// ---------------------------------------------------------------- 工具函数
function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function fileKey(p, stat) {
  return p + '|' + Math.floor(stat.mtimeMs) + '|' + stat.size;
}

// ---------------------------------------------------------------- 图标缓存
function loadIconCache() {
  const raw = readJsonSync(ICON_CACHE_FILE, null);
  if (raw && raw.version === 1 && raw.entries) iconCache = raw;
}

function scheduleIconCacheFlush() {
  iconCacheDirty = true;
  if (iconCacheTimer) return;
  iconCacheTimer = setTimeout(() => {
    iconCacheTimer = null;
    if (!iconCacheDirty) return;
    iconCacheDirty = false;
    // 裁剪：保留最近的 ICON_CACHE_LIMIT 条
    const keys = Object.keys(iconCache.entries);
    if (keys.length > ICON_CACHE_LIMIT) {
      const keep = {};
      for (const k of keys.slice(-ICON_CACHE_LIMIT)) keep[k] = iconCache.entries[k];
      iconCache.entries = keep;
    }
    try { writeJsonAtomic(ICON_CACHE_FILE, iconCache); } catch { /* 磁盘忙，下次再写 */ }
  }, 600);
  if (iconCacheTimer.unref) iconCacheTimer.unref();
}

/** 回退方案：Electron 自带的 getFileIcon（32/48px，解析不了快捷方式目标图标） */
async function fallbackIconDataUrl(filePath, stat) {
  const key = fileKey(filePath, stat);
  const hit = iconCache.entries[key];
  if (hit) return hit;
  try {
    const img = await app.getFileIcon(filePath, { size: ICON_SIZE });
    if (!img || img.isEmpty()) return '';
    const url = img.toDataURL();
    iconCache.entries[key] = url;
    scheduleIconCacheFlush();
    return url;
  } catch {
    return '';
  }
}

/* ------------------------------------------------- 真·系统图标（Shell 图像列表）
 * 只调一次 PowerShell，批量把每个项目的真实图标（优先 256×256 jumbo）导出成 PNG，
 * 之后按「路径+mtime+size」哈希复用磁盘缓存，不再重复提取。
 */
function iconFileName(item) {
  // 图标来源可能不是条目本身（扫描到的开始菜单快捷方式用目标 exe 的图标）：
  // 来源要参与哈希，否则同一份快捷方式会命中「快捷方式图标」与「程序图标」两份缓存。
  // ICON_REV 是提取算法版本：算法升级后旧图标要重取一次，不然已缓存的坏图标会一直留着。
  let seed = ICON_REV + '|' + item.path.toLowerCase() + '|' + item.mtime + '|' + item.size;
  if (item.iconSrc) seed += '|' + String(item.iconSrc).toLowerCase();
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return h.slice(0, 32) + '.png';
}

function runPowerShell(script, inFile, outFile) {
  return new Promise((resolve, reject) => {
    execFile('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-InFile', inFile, '-OutFile', outFile],
      { windowsHide: true, timeout: 40000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).slice(0, 300)));
        else resolve(String(stdout || '').trim());
      });
  });
}

function pruneIconCache(keep) {
  try {
    const files = fs.readdirSync(ICON_DIR).filter(f => f.endsWith('.png'));
    if (files.length <= Math.max(200, keep.size * 2)) return;
    const now = Date.now();
    for (const f of files) {
      if (keep.has(f)) continue;
      const full = path.join(ICON_DIR, f);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > 7 * 24 * 3600e3) fs.unlinkSync(full);   // 只删 7 天没用过的
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

async function ensureIcons(items, opts) {
  let extracted = 0, fallback = 0;
  try { fs.mkdirSync(ICON_DIR, { recursive: true }); } catch { /* ignore */ }

  const jobs = [];
  const pending = [];
  const keep = new Set();
  const custom = (config && config.customIcons) || {};

  for (const it of items) {
    // 用户右键换过的图标优先：不跑提取、不被默认图标覆盖
    const cf = custom[it.path];
    if (cf) {
      const full = path.join(ICON_DIR, cf);
      if (fs.existsSync(full)) {
        it.icon = 'nest-icon://icon/' + cf;
        keep.add(cf);
        continue;
      }
      delete custom[it.path];    // 图片已被清理 → 回退默认图标
    }
    // 网址条目没有磁盘文件，跳过取图标（否则会白跑一次 PowerShell + 回退）
    if (it.type === TYPE.URL || isUrlPath(it.path)) {
      it.type = TYPE.URL;
      it.target = it.target || it.path;
      it.icon = it.icon || '';
      continue;
    }
    const file = iconFileName(it);
    keep.add(file);
    it.icon = 'nest-icon://icon/' + file;
    if (!fs.existsSync(path.join(ICON_DIR, file))) {
      jobs.push({ src: it.iconSrc || it.path, out: path.join(ICON_DIR, file) });
      pending.push(it);
    }
  }

  if (jobs.length) {
    const inFile = path.join(ICON_DIR, '_jobs.json');
    const outFile = path.join(ICON_DIR, '_result.json');
    try {
      fs.writeFileSync(inFile, JSON.stringify(jobs));
      await runPowerShell(EXTRACT_SCRIPT, inFile, outFile);
      const res = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      for (const r of res) if (r.ok) extracted++;
    } catch { /* 整批失败 → 全部走回退 */ }
    // 没导出成功的项目用 getFileIcon 兜底，保证"绝不留空白"
    for (const it of pending) {
      const full = path.join(ICON_DIR, iconFileName(it));
      if (!fs.existsSync(full)) {
        const url = await fallbackIconDataUrl(it.path, { mtimeMs: it.mtime, size: it.size });
        if (url) it.icon = url;
        fallback++;
      }
    }
    try { fs.unlinkSync(inFile); } catch { /* ignore */ }
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
  }

  if (!opts || opts.prune !== false) pruneIconCache(keep);
  return { extracted, fallback, cached: items.length - jobs.length };
}

// ---------------------------------------------------------------- 桌面扫描
async function safeReaddir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 从 .url / .appref-ms 文本中抽取目标，纯文本解析，不调用 COM */
async function peekTarget(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    const m = text.match(/URL=([^\r\n]+)/i) || text.match(/(https?:\/\/[^\s"']+)/i);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function isScannable(name, isDir) {
  if (isDir) return true;
  if (name.startsWith('.')) return false;
  const lower = name.toLowerCase();
  if (lower === 'desktop.ini' || lower === 'thumbs.db') return false;
  return (
    lower.endsWith('.lnk') ||
    lower.endsWith('.url') ||
    lower.endsWith('.exe') ||
    lower.endsWith('.appref-ms')
  );
}

function detectType(name, isDir) {
  if (isDir) return TYPE.DIR;
  const lower = name.toLowerCase();
  if (lower.endsWith('.lnk')) return TYPE.LNK;
  if (lower.endsWith('.url')) return TYPE.URL;
  if (lower.endsWith('.appref-ms')) return TYPE.APPREF;
  if (lower.endsWith('.exe')) return TYPE.EXE;
  return TYPE.LNK;
}

function displayName(name) {
  return name.replace(/\.(lnk|url|appref-ms|exe)$/i, '');
}

async function scanDir(dir, source) {
  const entries = await safeReaddir(dir);
  const out = [];
  for (const ent of entries) {
    const isDir = ent.isDirectory();
    if (!isScannable(ent.name, isDir)) continue;
    const full = path.join(dir, ent.name);
    let stat;
    try { stat = await fsp.stat(full); } catch { continue; }
    const type = detectType(ent.name, isDir);
    let target = '';
    if (type === TYPE.URL || type === TYPE.APPREF) target = await peekTarget(full);
    out.push({
      path: full,
      name: displayName(ent.name),
      rawName: ent.name,
      type,
      source,                       // 'user' | 'public'
      mtime: Math.floor(stat.mtimeMs),
      size: stat.size,
      target,
      icon: ''
    });
  }
  return out;
}

/**
 * 全量扫描（仅启动时 / 手动点击时执行）
 * @param {boolean} withIcons 是否提取图标（缓存命中则零成本）
 */
async function scanDesktop(withIcons = true) {
  const userDesktop = app.getPath('desktop');
  const publicDesktop = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop');

  const [a, b] = await Promise.all([
    scanDir(userDesktop, 'user'),
    scanDir(publicDesktop, 'public')
  ]);

  const items = a.concat(b);
  // 同名去重：用户桌面优先
  const seen = new Set();
  const unique = items.filter(it => {
    const k = it.rawName.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 手动添加过的（不在桌面上的）应用：直接复用已存条目，不重复读盘
  if (config && config.extras) {
    const have = new Set(unique.map(it => it.path.toLowerCase()));
    for (const p in config.extras) {
      if (have.has(p.toLowerCase())) continue;
      if (!isUrlPath(p)) {
        try { fs.accessSync(p); } catch { continue; }   // 文件已删则跳过；网址条目没有磁盘文件，不能做存在性检查
      }
      unique.push(Object.assign({}, config.extras[p], isUrlPath(p) ? { type: TYPE.URL, target: config.extras[p].target || p } : null));
    }
  }

  if (withIcons) {
    await ensureIcons(unique);
  }

  return unique;
}

/**
 * 把磁盘路径批量转成可入库条目（文件对话框、文件夹对话框、拖拽添加共用）
 * @param {string[]} paths
 */
async function buildItems(paths) {
  const added = [];
  for (const p of paths) {
    let stat;
    try { stat = await fsp.stat(p); } catch { continue; }
    const isDir = stat.isDirectory();
    const base = path.basename(p);
    const item = {
      path: p,
      name: displayName(base),
      rawName: base,
      type: detectType(base, isDir),
      source: 'manual',
      mtime: Math.floor(stat.mtimeMs),
      size: stat.size,
      target: '',
      icon: ''
    };
    if (item.type === TYPE.URL) item.target = await peekTarget(p);
    added.push(item);
  }
  await ensureIcons(added);
  return added;
}

/* ------------------------------------------------ 已安装软件扫描（仅软件）
 * 只读两个开始菜单 Programs 目录里的 .lnk，解析出真实启动目标，再由主进程过滤：
 *   · 卸载 / 帮助 / 说明 / 官网 / 更新 这类快捷方式不是「应用」，直接剔掉
 *   · 指向 explorer.exe 且不是 shell:AppsFolder（UWP）的是文件夹快捷方式，也剔掉
 * 结果按名称排序；图标复用同一套 256px 提取 + 磁盘缓存。
 */
const APP_SCAN_TTL = 120000;
const APP_SKIP_NAME = /(卸载|uninstall|unins\d*|readme|帮助|使用说明|release notes|changelog|license|许可|官网|website|manual|documentation)/i;
const APP_SKIP_TARGET = /(uninstall|unins\d*|uninst|msiexec|rundll32|updater|update)/i;
let appScanCache = null;      // { at, items }

function runScanScript(outFile) {
  return new Promise((resolve, reject) => {
    execFile('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCAN_SCRIPT, '-OutFile', outFile],
      { windowsHide: true, timeout: 60000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).slice(0, 300)));
        else resolve(String(stdout || '').trim());
      });
  });
}

async function scanInstalledApps() {
  if (appScanCache && Date.now() - appScanCache.at < APP_SCAN_TTL) return appScanCache.items;

  const outFile = path.join(USER_DATA, 'app-scan.json');
  let raw = [];
  try {
    await runScanScript(outFile);
    const text = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '');
    raw = JSON.parse(text || '[]');
    if (!Array.isArray(raw)) raw = [raw];
  } catch (e) {
    console.log('[nest] 扫描已安装软件失败: ' + (e && e.message));
    return [];
  } finally {
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
  }

  const items = [];
  for (const rec of raw) {
    if (!rec || !rec.path) continue;
    const name = String(rec.name || '').trim();
    if (!name || APP_SKIP_NAME.test(name)) continue;
    const leaf = String(rec.target || '').split(/[\\/]/).pop() || '';
    if (!leaf || APP_SKIP_TARGET.test(leaf)) continue;
    if (/^explorer\.exe$/i.test(leaf) && !rec.uwp) continue;
    let stat;
    try { stat = fs.statSync(rec.path); } catch { continue; }
    items.push({
      path: rec.path,
      name,
      rawName: path.basename(rec.path),
      type: TYPE.LNK,
      source: 'scan',
      mtime: Math.floor(stat.mtimeMs),
      size: stat.size,
      target: rec.target || '',
      iconSrc: rec.icon || '',
      icon: ''
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
  await ensureIcons(items, { prune: false });
  appScanCache = { at: Date.now(), items };
  return items;
}

/* ------------------------------------------------ 卡片背景（壁纸 / 自选图片）
 * 背景图片不进渲染层的 img，也不需要 dataURL：主进程把「用户确认过的文件」登记进
 * bgFiles，渲染层只拿到 nest-icon://bg/<token>。路径永远不出主进程，
 * 渲染层就算被注入了也读不到磁盘上的任意文件。
 */
const bgFiles = new Map();          // token+ext -> 绝对路径

function registerBgFile(abs) {
  const ext = path.extname(abs).toLowerCase();
  const token = crypto.createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 32);
  const key = token + ext;
  bgFiles.set(key, abs);
  return 'nest-icon://bg/' + key;
}

/** 文件真实存在才给 URL（壁纸被删掉后自动回落到默认背景） */
function bgUrlFor(abs) {
  if (!abs || typeof abs !== 'string') return '';
  try {
    if (!fs.statSync(abs).isFile()) return '';
  } catch { return ''; }
  return registerBgFile(abs);
}

function cardBgState() {
  const cb = config && config.ui && config.ui.cardBg;
  if (!cb || !cb.file) return null;
  const url = bgUrlFor(cb.file);
  if (!url) return null;
  // 视频壁纸：静态帧当海报（首帧出来前先有画面），视频本身负责「会动 + 原生分辨率」
  const video = cb.video ? bgUrlFor(cb.video) : '';
  return { kind: cb.kind === 'we' ? 'we' : 'image', name: cb.name || '', url, video };
}

/* --------------------------------------------- 视频壁纸抽帧（卡片背景清晰度）
 * Wallpaper Engine 给的静态图是 preview.gif，实测只有 192×192；
 * 卡片是 880×530，铺满要放大约 4.6 倍 —— 怎么调 CSS 都是糊的，问题在源不够大。
 * 壁纸本体是 4K 视频，从里面抽一帧存成 JPEG，卡片才有真正的清晰度。
 * 每张壁纸只做一次，按「视频路径 + 大小 + 修改时间」缓存在 userData/bgframes。
 */
const BGFRAME_DIR = path.join(USER_DATA, 'bgframes');

function bgFrameCache(videoPath) {
  let st;
  try { st = fs.statSync(videoPath); } catch { return ''; }
  if (!st.isFile()) return '';
  const key = crypto.createHash('sha1')
    .update(videoPath.toLowerCase() + '|' + st.size + '|' + Math.round(st.mtimeMs))
    .digest('hex').slice(0, 24);
  return path.join(BGFRAME_DIR, key + '.jpg');
}

function extractVideoFrame(videoPath) {
  const out = bgFrameCache(videoPath);
  if (!out) return Promise.resolve('');
  // 已经有缓存帧（>2KB 说明是图不是空文件）就直接用，不再开窗口解码
  try { if (fs.statSync(out).size > 2048) return Promise.resolve(out); } catch { /* 还没抽过 */ }

  const htmlFile = path.join(app.getPath('temp'), 'nest-frame-' + crypto.randomBytes(6).toString('hex') + '.html');
  const html = [
    '<!doctype html><meta charset="utf-8">',
    '<style>html,body{margin:0;background:#000;overflow:hidden}video{display:none}</style>',
    '<video id="v" muted playsinline preload="auto" src="' + pathToFileURL(videoPath).href + '"></video>',
    '<script>(function(){',
    ' var v=document.getElementById("v"),done=false;',
    ' function grab(){',
    '  if(done)return; var vw=v.videoWidth||0,vh=v.videoHeight||0; if(!vw||!vh)return;',
    '  var W=Math.min(1600,vw),H=Math.round(W*vh/vw);',   // 卡片只要 ~880 宽，1600 足够锐且不吃内存
    '  var c=document.createElement("canvas");c.width=W;c.height=H;',
    '  try{ c.getContext("2d").drawImage(v,0,0,W,H); window.__nestFrame=c.toDataURL("image/jpeg",0.9); }',
    '  catch(e){ window.__nestFrame="ERR:"+e.message; }',
    '  done=true;',
    ' }',
    ' v.addEventListener("loadeddata",function(){ setTimeout(grab,260); });',
    ' v.addEventListener("seeked",grab);',
    ' v.addEventListener("error",function(){ window.__nestFrame="ERR:decode"; });',
    ' v.addEventListener("loadedmetadata",function(){',
    '  var t=isFinite(v.duration)?Math.min(v.duration*0.25,2.5):0;',
    '  try{ v.currentTime=t>0.05?t:0; }catch(e){}',
    '  var p=v.play(); if(p&&p.catch)p.catch(function(){});',
    ' });',
    ' setTimeout(grab,1800);',
    '})();</script>'
  ].join('\n');

  return new Promise((resolve) => {
    let done = false;
    let w = null;
    const finish = (file) => {
      if (done) return;
      done = true;
      try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* ignore */ }
      try { fs.unlinkSync(htmlFile); } catch { /* ignore */ }
      resolve(file);
    };
    try {
      fs.mkdirSync(BGFRAME_DIR, { recursive: true });
      fs.writeFileSync(htmlFile, html, 'utf8');
      w = new BrowserWindow({
        show: false, width: 1280, height: 720,
        webPreferences: { backgroundThrottling: false, nodeIntegration: false, contextIsolation: true }
      });
    } catch {
      finish('');
      return;
    }
    const started = Date.now();
    const poll = () => {
      if (done) return;
      if (Date.now() - started > 9000) { finish(''); return; }
      w.webContents.executeJavaScript('window.__nestFrame || ""', true)
        .then((data) => {
          if (typeof data === 'string' && data.startsWith('data:image/jpeg;base64,')) {
            try {
              fs.writeFileSync(out, Buffer.from(data.slice(23), 'base64'));
              finish(out);
            } catch { finish(''); }
            return;
          }
          if (typeof data === 'string' && data.startsWith('ERR:')) { finish(''); return; }
          setTimeout(poll, 180);
        })
        .catch(() => setTimeout(poll, 180));
    };
    w.webContents.once('did-finish-load', () => setTimeout(poll, 400));
    w.webContents.once('did-fail-load', () => finish(''));
    w.loadFile(htmlFile);
  });
}

/* ------------------------------------------------ Wallpaper Engine 壁纸库
 * 扫描脚本自己找 Steam 安装路径 + libraryfolders.vdf，列出创意工坊（appid 431960）
 * 与本地/内置 projects 里的壁纸，每条带一张静态图（preview.jpg/png/gif）。
 */
const WP_TTL = 300000;
let wpCache = null;                 // { at, items }

function runWallpaperScript(outFile) {
  return new Promise((resolve, reject) => {
    execFile('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WALLPAPER_SCRIPT, '-OutFile', outFile],
      { windowsHide: true, timeout: 60000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).slice(0, 300)));
        else resolve(String(stdout || '').trim());
      });
  });
}

async function listWallpapers() {
  if (wpCache && Date.now() - wpCache.at < WP_TTL) return wpCache.items;

  const outFile = path.join(USER_DATA, 'wallpaper-scan.json');
  let raw = [];
  try {
    await runWallpaperScript(outFile);
    const text = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '');
    raw = JSON.parse(text || '[]');
    if (!Array.isArray(raw)) raw = [raw];
  } catch (e) {
    console.log('[nest] 扫描壁纸失败: ' + (e && e.message));
    return [];
  } finally {
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
  }

  /* 「我的壁纸」判定在扫描脚本里完成：它读 Wallpaper Engine 的 config.json，
     只有真正被用户加载过的壁纸才算 used。本机 workshop 里的大批订阅可能并不是
     用户自己的库（共享库/历史合集），必须区分开，否则选壁纸时全是陌生条目。 */
  const items = [];
  for (const rec of raw) {
    if (!rec || !rec.image) continue;
    const url = bgUrlFor(rec.image);
    if (!url) continue;
    const type = String(rec.type || '').toLowerCase();
    items.push({
      id: String(rec.id || ''),
      title: String(rec.title || '').trim() || '未命名壁纸',
      type,
      // 动态 = 会动的：视频/网页/应用类壁纸，或直接给的是动图预览
      dynamic: /video|web|application/.test(type) || /\.gif$/i.test(rec.image),
      used: rec.used !== false,
      image: rec.image,
      // 视频壁纸的本体（抽帧用）：preview.gif 只有 192×192，铺满卡片一定糊
      video: String(rec.video || ''),
      url
    });
  }
  // 我的壁纸排前面，其余按标题排
  items.sort((a, b) => {
    if (!!a.used !== !!b.used) return a.used ? -1 : 1;
    return a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  });
  wpCache = { at: Date.now(), items };
  return items;
}

// ---------------------------------------------------------------- 配置
const DEFAULT_CONFIG = {
  version: 1,
  // 这几个容器键必须默认就在：全新配置时 loadConfig() 直接返回这份默认值、不走下面那段归一化，
  // 缺了它们「添加应用」会在第一次写入 config.extras / config.assign 时直接抛错。
  assign: {},       // path -> folderId（含手动移动结果）
  manual: {},       // path -> true 表示用户手动指定过，重扫不覆盖
  hidden: [],       // type=file 等被手动添加到「已隐藏」的路径
  extras: {},       // 手动添加的应用/网址条目 path -> 条目
  keepEmpty: {},    // folderId -> true 表示空页也保留
  customIcons: {},  // path -> iconcache 里的自定义图标文件名（右键换图标）
  folders: [
    { id: 'dev', name: '编程开发', color: '#4f8cff', catKey: 'dev', order: 0, items: [] },
    { id: 'folder', name: '桌面文件夹', color: '#37d5ff', catKey: 'folder', order: 1, items: [] }
  ],
  ui: {
    alwaysOnTop: false,     // 默认不置顶：圆钮只在桌面出现，不骚扰正在用的窗口（设置里可开）
    collapsed: true,        // 启动后先以「桌面圆钮」形态出现
    pageIndex: 0,           // 记住上次看的页
    showHiddenToggle: false,
    window: null,           // {x,y,width,height}
    desktopIconsHidden: false,
    cardBg: null,            // 卡片背景：{ kind:'we'|'image', file, name }，null = 默认浅色背景
    glassOpacity: 80,        // 背景透明度（%）：100 = 全透、0 = 完全不透。默认 80，看得出桌面但字仍清楚
    transparencyV2: true     // 语义标记：老配置里 glassOpacity 是「不透明度」，需要翻转一次
  }
};

function loadConfig() {
  const cfg = readJsonSync(CONFIG_FILE, null);
  if (!cfg || typeof cfg !== 'object') return structuredClone(DEFAULT_CONFIG);
  cfg.folders = Array.isArray(cfg.folders) ? cfg.folders : [];
  cfg.assign = cfg.assign || {};
  cfg.manual = cfg.manual || {};
  cfg.hidden = Array.isArray(cfg.hidden) ? cfg.hidden : [];
  cfg.extras = cfg.extras && typeof cfg.extras === 'object' ? cfg.extras : {};
  cfg.keepEmpty = cfg.keepEmpty && typeof cfg.keepEmpty === 'object' ? cfg.keepEmpty : {};
  cfg.customIcons = cfg.customIcons && typeof cfg.customIcons === 'object' ? cfg.customIcons : {};
  const rawUi = cfg.ui && typeof cfg.ui === 'object' ? cfg.ui : {};
  cfg.ui = Object.assign({}, DEFAULT_CONFIG.ui, rawUi);
  /* 老配置里 glassOpacity 存的是「不透明度」（95 ≈ 全白），现在滑条是「透明度」。
     不翻转的话，老用户升级后卡片会近乎全透（等于直接看不见），所以这里只翻一次。 */
  if (!rawUi.transparencyV2) {
    cfg.ui.glassOpacity = rawUi.glassOpacity != null ? 100 - rawUi.glassOpacity : 80;
    cfg.ui.transparencyV2 = true;
  }
  // v3 收尾：撤销上一版"默认置顶"的实验值 —— 桌面圆钮只在桌面出现，不压到别的窗口上
  if (cfg.ui.topDefault3 === true) {
    cfg.ui.alwaysOnTop = false;
    cfg.ui.topDefault3 = false;
  }
  if (!cfg.folders.length) cfg.folders = structuredClone(DEFAULT_CONFIG.folders);
  return cfg;
}

let config = null;

function saveConfig() {
  if (!config) return;
  try { writeJsonAtomic(CONFIG_FILE, config); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 桌面图标显隐
const ADV_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';

function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ code: err && err.code != null ? err.code : 0, out: String(stdout || stderr || '').trim() });
    });
  });
}

function readDesktopIconsHidden() {
  return new Promise(resolve => {
    execFile('reg', ['query', ADV_KEY, '/v', 'HideIcons'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      const m = String(stdout).match(/HideIcons\s+REG_DWORD\s+0x([0-9a-f]+)/i);
      resolve(!!m && parseInt(m[1], 16) === 1);
    });
  });
}

/**
 * 让「显示桌面图标」开关立即生效：向 SHELLDLL_DefView 发 WM_COMMAND 0x7402。
 * 不重启 explorer、不注入、不挂钩，等价于右键菜单里点「显示桌面图标」。
 * 注意：部分机器上 FindWindow("Progman") 取不到句柄，所以统一走 EnumWindows 查找。
 */
const PS_TOGGLE = `
$ErrorActionPreference='Continue';
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class NestShell {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string title);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  public static IntPtr Progman = IntPtr.Zero;
  public static bool OnTop(IntPtr h, IntPtr l){
    StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256);
    if (sb.ToString() == "Progman" && Progman == IntPtr.Zero) Progman = h;
    return true;
  }
  public static IntPtr GetDefView(){
    Progman = IntPtr.Zero;
    EnumWindows(new EnumProc(OnTop), IntPtr.Zero);
    if (Progman != IntPtr.Zero) {
      IntPtr d = FindWindowEx(Progman, IntPtr.Zero, "SHELLDLL_DefView", null);
      if (d != IntPtr.Zero) return d;
      IntPtr c = IntPtr.Zero;
      while ((c = FindWindowEx(Progman, c, null, null)) != IntPtr.Zero) {
        d = FindWindowEx(c, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (d != IntPtr.Zero) return d;
      }
    }
    IntPtr w = IntPtr.Zero;
    while ((w = FindWindowEx(IntPtr.Zero, w, "WorkerW", null)) != IntPtr.Zero) {
      IntPtr d = FindWindowEx(w, IntPtr.Zero, "SHELLDLL_DefView", null);
      if (d != IntPtr.Zero) return d;
    }
    return IntPtr.Zero;
  }
}
"@;
$h = [NestShell]::GetDefView();
if ($h -eq [IntPtr]::Zero) { Write-Output 'NODEFVIEW'; exit 0 }
$r = [IntPtr]::Zero;
[void][NestShell]::SendMessageTimeout($h, 0x0111, [IntPtr]0x7402, [IntPtr]::Zero, 2, 3000, [ref]$r);
Write-Output 'OK';
`;

async function toggleDesktopIconsLive() {
  const r = await new Promise(resolve => {
    execFile('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_TOGGLE],
      { windowsHide: true, timeout: 9000 },
      (err, stdout) => resolve({ err: err ? String(err.message) : '', out: String(stdout || '').trim() })
    );
  });
  return { ok: r.out.includes('OK'), raw: r.out || r.err };
}

/**
 * @param {boolean} visible 目标状态：true = 显示桌面图标
 */
async function applyDesktopIconsVisible(visible) {
  const before = await readDesktopIconsHidden();       // explorer 会实时同步该键，可作为真状态
  if (before === !visible) {
    return { hidden: before, changed: false, live: true };
  }
  // 1) 写注册表：保证下次登录 / 重启 explorer 后状态一致
  await run('reg', ['add', ADV_KEY, '/v', 'HideIcons', '/t', 'REG_DWORD', '/d', visible ? '0' : '1', '/f']);
  // 2) 立即生效
  const live = await toggleDesktopIconsLive();
  // 3) 回读真状态（explorer 自己也会写该键）
  const after = await readDesktopIconsHidden();
  return { hidden: after, changed: true, live: live.ok, raw: live.raw };
}

// ---------------------------------------------------------------- 窗口
const EDGE_GAP = 14;                                     // 距任务栏留白（面板本体还要再加 PAD）
const WINDOW_PAD = 20;                                   // 窗口比玻璃面板大一圈，用来放 CSS 投影
const COLLAPSED_SIZE = { width: 84, height: 84 };       // 桌面上那颗小圆钮（54px 圆 + 投影空间）
const EXPANDED_FALLBACK = { width: 960, height: 680 };

/** 底部居中摆放（水平方向沿用窗口当前中心，避免切换时"跳走"） */
function anchoredBounds(size) {
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(size.width + WINDOW_PAD * 2, wa.width - 24);
  const height = Math.min(size.height + WINDOW_PAD * 2, wa.height - 24);
  let cx = wa.x + wa.width / 2;
  if (win && !win.isDestroyed()) {
    const cur = win.getBounds();
    cx = cur.x + cur.width / 2;
  }
  const x = Math.round(Math.min(Math.max(cx - width / 2, wa.x + 12), wa.x + wa.width - width - 12));
  const y = Math.round(wa.y + wa.height - height - EDGE_GAP);
  return { x, y, width, height };
}

/** 上次关闭时的位置和尺寸优先；越界就拉回工作区，没有记录才退回底部居中 */
function restoredBounds(saved, size) {
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
    return anchoredBounds(size);
  }
  if (saved.width < 460 || saved.height < 320) return anchoredBounds(size);
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(Math.round(saved.width), wa.width - 24);
  const height = Math.min(Math.round(saved.height), wa.height - 24);
  const sx = Number.isFinite(saved.x) ? Math.round(saved.x) : Math.round(wa.x + (wa.width - width) / 2);
  const sy = Number.isFinite(saved.y) ? Math.round(saved.y) : Math.round(wa.y + wa.height - height - EDGE_GAP);
  const x = Math.min(Math.max(sx, wa.x + 12), wa.x + wa.width - width - 12);
  const y = Math.min(Math.max(sy, wa.y + 12), wa.y + wa.height - height - 12);
  return { x, y, width, height };
}

/** 一次性窗口形变动画（约 280ms，之后不再有任何定时器）
 *  两个坑都在这里兜住：
 *   1) Windows 上 setBounds 对"不可缩放"窗口无效 → 动画前必须先把 resizable 恢复成 true
 *   2) 万一中途被打断/抛错，ms+500 的兜底一定会把窗口落到目标尺寸，绝不留在半路
 */
let boundsAnimating = false;
function animateBounds(target, ms = 280) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  const from = win.getBounds();
  const steps = Math.max(1, Math.round(ms / 16));
  const start = Date.now();
  boundsAnimating = true;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      boundsAnimating = false;
      if (win && !win.isDestroyed()) {
        try { win.setBounds(target); } catch { /* ignore */ }
      }
      resolve();
    };
    let i = 0;
    const tick = () => {
      if (done) return;
      i++;
      const dt = Date.now() - start;
      const t = Math.min(1, dt / ms);                        // 以实际经过时间为准，每一步天然自纠偏
      const e = 1 - Math.pow(1 - t, 3);
      if (win && !win.isDestroyed()) {
        try {
          win.setBounds({
            x: Math.round(from.x + (target.x - from.x) * e),
            y: Math.round(from.y + (target.y - from.y) * e),
            width: Math.round(from.width + (target.width - from.width) * e),
            height: Math.round(from.height + (target.height - from.height) * e)
          });
        } catch { /* 被系统拒绝也不中断，交给 finish() 兜底 */ }
      }
      if (t >= 1) { finish(); return; }
      // 对齐到预定的节拍，防 setTimeout 累积漂移
      const nextTick = start + Math.round(((i) / steps) * ms);
      setTimeout(tick, Math.max(1, nextTick - Date.now()));
    };
    setTimeout(finish, ms + 600);
    tick();
  });
}

function applyCollapsedWindow(collapsed, target) {
  if (!win || win.isDestroyed()) return;
  // 顺序很关键（本机实测踩坑）：
  //   Windows 上先 setResizable(false) 会立刻按"当时的 min 尺寸"把窗口夹大，而且之后 setBounds 会被忽略。
  //   所以：1) 先放开/收紧尺寸限额 2) 把位置钉死 3) 最后才切 resizable。
  //   target 必须由调用方传"动画的目标 bounds"：如果这里再算一次，就会按被夹过的当前中心重算，
  //   实测每次收起横向偏 +278px（700 宽下限把 144 宽的动画夹住，中心 = x+350 而不是 x+72）。
  const bounds = target || anchoredBounds(collapsed ? COLLAPSED_SIZE : EXPANDED_FALLBACK);
  win.setMinimumSize(collapsed ? COLLAPSED_SIZE.width : 700, collapsed ? COLLAPSED_SIZE.height : 460);
  win.setMaximizable(!collapsed);
  // 收起态不给"最小化框"：这样 Win+D / 显示桌面 只会最小化别的窗口，圆钮会留在桌面上
  // —— 这正是"所有软件最小化时它才出现"的零轮询实现。
  win.setMinimizable(!collapsed);
  win.setBounds(bounds);
  win.setResizable(!collapsed);
}

/** 真·毛玻璃数据源：一次性抓屏 → 缩到 96×60（几 KB）→ 交给渲染层做 CSS blur。
 *  为什么不用 desktopCapturer：本机实测 getSources() 会把主进程**阻塞死**（窗口再也 show 不出来、
 *  调试端口无响应）。PowerShell 一次性抓屏 + execFile 不占主线程，事件驱动、无轮询、无常驻流。
 *  注意：必须是**模块作用域**函数 —— 之前误插在 registerIpc() 里，ready-to-show 调不到，
 *  启动直接 ReferenceError 弹原生错误框（窗口被对话框挡住），只在日志里能看到 fallback show 救回来。 */
let backdropCache = null;
let backdropPromise = null;
async function captureBackdrop() {
  try {
    const out = path.join(app.getPath('userData'), 'backdrop.png');
    const wa = screen.getPrimaryDisplay().bounds;
    const { execFile } = require('node:child_process');
    await new Promise((res) => {
      execFile('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
          '-File', path.join(__dirname, 'tools', 'grab-backdrop.ps1'),
          '-Out', out, '-W', '240', '-H', '150', '-SW', String(wa.width), '-SH', String(wa.height)],
        { windowsHide: true, timeout: 6000 },
        (err) => {
          if (err) console.log('[nest] backdrop 抓屏失败: ' + err.message);
          res();
        });
    });
    const buf = fs.readFileSync(out);
    backdropCache = 'data:image/png;base64,' + buf.toString('base64');
    console.log('[nest] backdrop ' + buf.length + ' bytes');
    return backdropCache;
  } catch (e) {
    console.log('[nest] backdrop 异常: ' + e.message);
    return null;
  }
}

/** 常驻抓屏流：让玻璃底图「活着」。
 *  之前是启动时抓一次，所以网页 A 最小化后玻璃里还留着 A 的样子 —— 底图根本不会更新。
 *  现在开一个常驻 PowerShell（避免每次 spawn 的 300~600ms 冷启动），每 250ms 让它抓一帧
 *  「卡片正下方那块屏幕」，缩到 200×130 后以 base64 回传，渲染层直接换 --backdrop。
 *  抓屏期间脚本会临时给本窗口设 WDA_EXCLUDEFROMCAPTURE（对抓屏隐形、对人眼无感），
 *  否则会把卡片自己那层白雾拍进去形成递归。 */
let backdropStream = null;
let backdropTick = null;
let backdropPending = false;
function startBackdropStream() {
  if (backdropStream || process.platform !== 'win32' || !win || win.isDestroyed()) return;
  try {
    const ps1 = path.join(__dirname, 'tools', 'backdrop-stream.ps1');
    if (!fs.existsSync(ps1)) return;
    const buf = win.getNativeWindowHandle();
    const hwnd = (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))).toString();
    const { spawn } = require('node:child_process');
    backdropStream = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, hwnd],
      { windowsHide: true });
    let pending = '';
    backdropStream.stdout.on('data', (d) => {
      pending += d.toString('utf8');
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i).trim();
        pending = pending.slice(i + 1);
        if (!line) continue;
        backdropPending = false;
        setCaptureHidden(false);
        if (line === 'ERR') continue;
        if (win && !win.isDestroyed()) win.webContents.send('nest:backdrop-frame', line);
      }
    });
    backdropStream.stderr.on('data', (d) => console.log('[nest] backdrop-stream ' + d.toString('utf8').trim().slice(0, 300)));
    backdropStream.on('exit', () => { backdropStream = null; });
    backdropTick = setInterval(pulseBackdrop, 250);
    console.log('[nest] backdrop-stream 已启动');
  } catch (e) {
    console.log('[nest] backdrop-stream 启动失败: ' + e.message);
  }
}
function pulseBackdrop() {
  if (!backdropStream || !win || win.isDestroyed() || !win.isVisible() || backdropPending) return;
  const b = win.getBounds();
  const sf = screen.getDisplayMatching(b).scaleFactor || 1;
  const x = Math.round((b.x + WINDOW_PAD) * sf);
  const y = Math.round((b.y + WINDOW_PAD) * sf);
  const w = Math.round((b.width - WINDOW_PAD * 2) * sf);
  const h = Math.round((b.height - WINDOW_PAD * 2) * sf);
  if (w < 8 || h < 8) return;
  backdropPending = true;
  setCaptureHidden(true);
  // WDA 要等 DWM 合成一帧才在抓屏面里生效（约 16ms），所以先隐形、隔一帧再抓。
  setTimeout(() => {
    if (!backdropStream) { backdropPending = false; setCaptureHidden(false); return; }
    try { backdropStream.stdin.write('grab ' + x + ' ' + y + ' ' + w + ' ' + h + '\n'); }
    catch (e) { backdropPending = false; setCaptureHidden(false); }
  }, 18);
}
/* 抓屏的那一瞬间让窗口对抓屏「隐形」，抓完立刻恢复：
   · 不隐形 → 玻璃把卡片自己拍进去，自己映自己 → 永远是一块白板（这是之前所有失败的根因）
   · 一直隐形 → 用户自己按 Win+Shift+S 截图时卡片会整个消失
   所以只在每次 grab 前后的那几十毫秒里开着。 */
function setCaptureHidden(on) {
  try {
    if (!win || win.isDestroyed()) return;
    if (typeof win.setContentProtection === 'function') win.setContentProtection(!!on);
  } catch (e) { }
}
function stopBackdropStream() {
  if (backdropTick) { clearInterval(backdropTick); backdropTick = null; }
  if (backdropStream) {
    try { backdropStream.stdin.write('quit\n'); } catch (e) { }
    try { backdropStream.kill(); } catch (e) { }
    backdropStream = null;
  }
}

/** 把窗口插到 Progman 桌面宿主正上方 —— 桌面壁纸之上、所有普通窗口之下。
 *  一次性的 PowerShell 调用（~300ms）。不管成不成都打日志，方便排查。 */
function pushToBottom() {
  return new Promise((resolve) => {
    try {
      if (!win || win.isDestroyed()) return resolve('destroyed');
      if (config.ui.alwaysOnTop) return resolve('alwaysOnTop');
      const buf = win.getNativeWindowHandle();
      const hwnd = (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))).toString();
      const ps1 = path.join(__dirname, 'tools', 'push-bottom.ps1');
      if (!fs.existsSync(ps1)) return resolve('no-script');
      const { execFile } = require('node:child_process');
      execFile('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1, '-Hwnd', hwnd],
        { windowsHide: true, timeout: 6000 },
        (err, stdout) => {
          const r = err ? 'err:' + err.message : String(stdout).trim();
          console.log('[nest] push-bottom ' + r);
          resolve(r);
        });
    } catch (e) { console.log('[nest] push-bottom 异常: ' + e.message); resolve('exception'); }
  });
}

/** 真·系统丙烯酸（**默认关闭，别再打开**）：
 *  实测两个后果：① 本机 blur 完全无效（改完画面零变化）；② DWM 会按 DWMWA_SYSTEMBACKDROP_TYPE +
 *  DWMWA_WINDOW_CORNER_PREFERENCE 给窗口画一层浅色圆角系统底 → 视觉上就是"球/面板外面套了个白色矩形框"，
 *  收起态和展开态都中招。只设 SetWindowCompositionAttribute（accent=4），不碰 Dwm* 两兄弟。 */
function applyRealAcrylic() {
  try {
    if (!win || win.isDestroyed()) return;
    const buf = win.getNativeWindowHandle();
    const hwnd = (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))).toString();
    const ps1 = path.join(__dirname, 'tools', 'apply-acrylic.ps1');
    if (!fs.existsSync(ps1)) return;
    const { execFile } = require('node:child_process');
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1,
        '-Hwnd', hwnd],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) { console.log('[nest] acrylic err: ' + err.message); return; }
        const r = String(stdout).trim();
        console.log('[nest] acrylic ' + r);
        if (win && !win.isDestroyed() && (r.includes('accent=0') || r.includes('dwm=0'))) {
          win.webContents.send('nest:acrylic', true);
        }
      });
  } catch (e) { console.log('[nest] acrylic 异常: ' + e.message); }
}

function createWindow() {
  const saved = (config.ui && config.ui.window) || null;
  // 启动直接显示卡片面板，不再经过桌面小球
  const collapsed = false;
  config.ui.collapsed = false;
  const expandedSize = EXPANDED_FALLBACK;
  const start = restoredBounds(saved, expandedSize);
  // NEST_GLASS: 0=纯 CSS 玻璃(透明窗口，本机实测系统 acrylic 不可用) 1=acrylic+透明窗口 2=acrylic+不透明窗口
  const glassMode = process.env.NEST_GLASS == null ? '0' : String(process.env.NEST_GLASS);
  const useAcrylic = glassMode !== '0';
  const transparentWin = glassMode === '0' || glassMode === '1';
  const opts = {
    x: start.x, y: start.y, width: start.width, height: start.height,
    minWidth: 460,
    minHeight: 320,
    frame: false,
    transparent: transparentWin,
    backgroundColor: '#00000000',
    backgroundMaterial: 'none',   // 我们自己用 PowerShell 设 acrylic，不要让 Electron 再抢着设一次
    hasShadow: true,
    roundedCorners: false,    // DWM 圆角会给透明无边框窗口画一层系统色底，就是那个白框
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    show: false,
    title: 'DeskNest',
    icon: path.join(__dirname, 'assets', 'desknest.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: true,
      devTools: process.env.NEST_DEV === '1'
    }
  };

  win = new BrowserWindow(opts);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 临时探针：把渲染层真实几何/样式打到主进程日志（NEST_PROBE=1），用来定位"白方块"到底是谁画的
  if (process.env.NEST_PROBE === '1' || process.env.NEST_PROBE === '2') {
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        const js = `(() => {
          const pick = (sel) => {
            const e = document.querySelector(sel);
            if (!e) return sel + ': 不存在';
            const c = getComputedStyle(e), b = e.getBoundingClientRect();
            return sel + ': ' + Math.round(b.x) + ',' + Math.round(b.y) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height)
              + ' display=' + c.display + ' bg=' + c.background.slice(0, 70) + ' op=' + c.opacity;
          };
          return JSON.stringify({
            bodyClass: document.body.className,
            htmlBg: getComputedStyle(document.documentElement).background.slice(0, 50),
            items: ['#app', '.glass', '.frost', '.chip', '.chip-btn'].map(pick)
          });
        })()`;
        win.webContents.executeJavaScript(js, true).then(
          (r) => console.log('[probe] ' + r),
          (e) => console.log('[probe] 失败: ' + e.message));
        if (process.env.NEST_PROBE === '2') {
          // A/B 测帧：A = 现在的实现，B = 注入旧的"三块大面积重绘"样式，看掉帧差多少
          const morph = `(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const btn = document.getElementById('chipFolder');
            let frames = [], last = performance.now(), run = true;
            const loop = () => { const t = performance.now(); frames.push(t - last); last = t; if (run) requestAnimationFrame(loop); };
            requestAnimationFrame(loop);
            const stat = (a) => a.length < 3 ? { n: a.length } : ({ n: a.length, avg: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1), max: +Math.max.apply(null, a).toFixed(1), over32: a.filter(x => x > 32).length });
            const cycle = async () => { btn.click(); await sleep(800); btn.click(); await sleep(800); const c = frames.slice(3); frames = []; return stat(c); };
            const W = await cycle();                                    // 预热：丢掉（首轮含冷启动/字体/图标栅格化）
            const A1 = await cycle();
            const st = document.createElement('style');
            st.textContent = 'body.morphing .frost{display:block !important;filter:blur(32px) saturate(1.65) brightness(1.04) !important}body.morphing .glass::before,body.morphing .glass::after{display:block !important}body.morphing .glass{backdrop-filter:blur(26px) saturate(1.5) !important;-webkit-backdrop-filter:blur(26px) !important}';
            document.head.appendChild(st);
            const B = await cycle();
            st.remove();
            const A2 = await cycle();
            run = false;
            return JSON.stringify({ warm: W, fixed1: A1, old: B, fixed2: A2 });
          })()`;
          win.webContents.executeJavaScript(morph, true).then(
            (r) => console.log('[probe] morph ' + r),
            (e) => console.log('[probe] morph 失败: ' + e.message));
        }
      }, 2500);
    });
  }

  win.once('ready-to-show', async () => {
    // 先彻底关掉任何"鼠标穿透"状态，再显示：透明窗口一旦被置成 ignore，点击会直接落到后面的软件
    win.setIgnoreMouseEvents(false);
    applyTopmost();
    // 磨砂白需要一个「会动的底图」才有真模糊：抓屏流照旧在 show 前拉起（Add-Type 编译要 1~2 秒，
    // 提前启动能藏在首帧里）。抓到的只是明暗信息，颜色在 CSS 里被彻底去掉，不会再出现整卡变绿。
    startBackdropStream();
    win.show();
    // 让本窗口对抓屏「隐形」（WDA_EXCLUDEFROMCAPTURE）。这一步必须在本进程内调，
    // 外部 PowerShell 调 SetWindowDisplayAffinity 会被系统拒绝（ERROR_ACCESS_DENIED），
    // 那正是之前玻璃里一直映着卡片自己、怎么看都是一块白板的原因。
    // 人眼照旧看得见卡片，只是抓屏拍不到它，抓出来的就是它背后真实的桌面。
    // 抓屏隐形只维持在每个 grab 前后（见 setCaptureHidden），不常开，否则会挡掉用户自己的截图。
    applyTopmost();
    console.log('[nest] ready-to-show → visible=' + win.isVisible() + ' size=' + JSON.stringify(win.getSize()));
    timing('first-paint');
    // DWM Acrylic 会给透明无边框窗口铺一整块方形米白底（实测 232,227,218），
// 比 CSS 圆角大一圈 → 就是那个"多余白色背景"。默认彻底关闭，只在调试时 NEST_ACR=1 开。
    if (process.env.NEST_ACR === '1') applyRealAcrylic();
  });

  // 兜底：透明无边框窗口在个别 Windows 版本上 ready-to-show 会迟到，1.2s 后仍未显示就直接 show
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      win.show();
      console.log('[nest] fallback show → visible=' + win.isVisible());
    }
  }, 1200);

  win.on('minimize', () => {
    // 正常最小化：交给 Windows 处理（不再需要强制恢复+压底）
    sendWinState();
  });

  // 隐藏 / 最小化 → 通知渲染进程彻底停摆（暂停动画 + 停定时器）
  const notify = () => { sendWinState(); updateTrayMenu(); };
  win.on('hide', notify);
  win.on('show', notify);
  // 每次重新显示都把置顶和鼠标命中重新落实一遍：hide/showInactive 之后部分 Windows 会把这两项丢掉
  win.on('show', () => { win.setIgnoreMouseEvents(false); applyTopmost(); });
  win.on('minimize', notify);
  // 从任务栏还原：Windows 自己恢复窗口，不一定触发 show。
  // 之前这里只发个状态，于是"点任务栏展开后卡片点不动"（鼠标命中还停在旧状态）。
  win.on('restore', () => {
    win.setIgnoreMouseEvents(false);
    applyTopmost();
    notify();
  });
  win.on('focus', notify);
  win.on('blur', notify);

  win.on('resize', saveWindowBoundsThrottled);
  win.on('move', saveWindowBoundsThrottled);

  win.on('closed', () => { win = null; });

  // 关闭窗口 = 收进托盘；真正退出只走托盘菜单 / 设置里的「退出」
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    sendWinState();
  });
  return win;
}

/** 置顶是"真·系统置顶"，不是只画在上层：每次显示后重新设一遍，避免点击落到底下软件 */
function applyTopmost() {
  if (!win || win.isDestroyed()) return;
  const on = !!(config.ui && config.ui.alwaysOnTop);
  win.setAlwaysOnTop(on, 'floating');
  if (on) win.moveTop();
}

// ---------------------------------------------------------------- 托盘
let tray = null;

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'desknest.ico'));
  } catch (e) {
    console.log('[nest] 托盘创建失败: ' + (e && e.message));
    return;
  }
  tray.setToolTip('DeskNest · 桌面收纳');
  tray.on('click', toggleWindow);
  tray.on('double-click', revealWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const shown = !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: shown ? '隐藏面板' : '显示面板', click: toggleWindow },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: !!(config.ui && config.ui.alwaysOnTop),
      click: (item) => {
        config.ui.alwaysOnTop = !!item.checked;
        saveConfig();
        applyTopmost();
        sendWinState();
        updateTrayMenu();
      }
    },
    { type: 'separator' },
    { label: '退出 DeskNest', click: () => { quitting = true; app.quit(); } }
  ]));
}

let boundsTimer = null;
function saveWindowBoundsThrottled() {
  if (boundsTimer) return;
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    if (!win || win.isDestroyed() || !config) return;
    // 收起态只有一颗"手机文件夹"，展开动画中的中间尺寸也不值得记
    if (config.ui.collapsed !== false || boundsAnimating) return;
    const b = win.getNormalBounds();
    config.ui.window = { x: b.x, y: b.y, width: b.width, height: b.height };
    saveConfig();
  }, 800);
}

function sendWinState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('nest:win-state', {
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    focused: win.isFocused(),
    alwaysOnTop: win.isAlwaysOnTop(),
    collapsed: config.ui.collapsed !== false
  });
}

/**
 * 用户主动叫出窗口（托盘 / 快捷键 / 任务栏）：必须 show + focus + moveTop。
 * 之前用 showInactive，窗口虽然显示了却在前台软件后面，第一次点击落到的是别的软件，
 * 看起来就像"卡片被置于底层、点不动"。
 */
function revealWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.setIgnoreMouseEvents(false);
  win.show();
  win.focus();
  if (!(config.ui && config.ui.alwaysOnTop)) win.moveTop();   // 非置顶时也抬到普通窗口最上层
  sendWinState();
  updateTrayMenu();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && !win.isMinimized()) {
    win.hide();
    sendWinState();
    updateTrayMenu();
    return;
  }
  revealWindow();
}

// ---------------------------------------------------------------- 分类
const { classify, CATEGORY_ORDER, CATEGORY_META } = require('./src/catalog.js');

/** 扫描结果 → 文件夹归属
 *  这里只做「减法」：清掉已不存在的条目、剥离手动隐藏的、收拾空页。
 *  桌面上的图标不会被自动塞进卡片 —— 老版本每次启动都会扫桌面并把所有快捷方式吸进来，
 *  新用户看到的就是「我还没添加，卡片里怎么已经有 5 个软件」。
 *  要进卡片只能手动加：设置里的「添加应用」或在「扫描」里勾选（见 nest:add-extras）。
 */
function reconcile(items) {
  const byPath = new Map(items.map(it => [it.path, it]));
  const folders = config.folders;

  // 1) 清理已不存在的条目
  for (const f of folders) {
    f.items = f.items.filter(p => byPath.has(p));
  }

  // 2) 剥离「已被手动隐藏」的条目
  const hiddenSet = new Set(config.hidden);
  for (const it of items) {
    if (hiddenSet.has(it.path)) {
      for (const f of folders) f.items = f.items.filter(p => p !== it.path);
    }
  }

  // 3) 清掉空的自建页（保留默认两个）
  config.folders = folders
    .filter(f => f.items.length > 0 || f.id === 'dev' || f.id === 'folder' || config.keepEmpty[f.id])
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  return { created: [], items };
}

// ---------------------------------------------------------------- 开机自启
/**
 * 开发态直接 setLoginItemSettings({openAtLogin:true}) 注册的是 electron.exe 本身，
 * 不带项目路径 —— 登录后只会弹一个空 Electron，DeskNest 根本起不来。
 * 所以开发态要显式带上 app 路径；读取状态时也必须带同样的参数才配对得上。
 *
 * 注意不能用 app.isPackaged 判断：在本机用 node_modules/electron 直接跑时它实测也返回 true，
 * 条件永远不成立、args 永远补不上。用可执行文件位置判断最可靠。
 */
// electron.exe 现在可能叫 electron-core.exe（真引擎被改名，同目录的 electron.exe 是转发器），两种都要认。
const DEV_ELECTRON = /[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron(-core)?(\.exe)?$/i;

/* 应用根目录：开发态是项目目录；便携包是 resources\app 往上两层。 */
function appRoot() {
  return DEV_ELECTRON.test(process.execPath)
    ? app.getAppPath()
    : path.resolve(app.getAppPath(), '..', '..');
}

/* 带 DeskNest 自己图标的启动器。它和引擎同目录，引擎自己会找 resources\app，
   所以启动器不需要传任何参数 —— 少一条「裸启动」的路，就不会有欢迎页。 */
function resolveLauncher() {
  const p = path.join(appRoot(), 'DeskNest.exe');
  return fs.existsSync(p) ? p : process.execPath;
}

function loginItemOptions(extra) {
  const opts = Object.assign({}, extra);
  const launcher = resolveLauncher();
  if (launcher !== process.execPath) {
    // 注册启动器：开机后它自己补 app 路径，不会只弹一个空 Electron
    opts.path = launcher;
    opts.args = [];
  } else if (DEV_ELECTRON.test(process.execPath)) {
    opts.path = process.execPath;
    opts.args = [app.getAppPath()];
  }
  return opts;
}

/* 桌面快捷方式：指向启动器，图标就是 DeskNest 自己的 ico。 */
function createDesktopShortcut() {
  const target = resolveLauncher();
  const lnk = path.join(app.getPath('desktop'), 'DeskNest.lnk');
  const q = (s) => String(s).replace(/'/g, "''");
  const ps = [
    "$ws = New-Object -ComObject WScript.Shell",
    `$s = $ws.CreateShortcut('${q(lnk)}')`,
    `$s.TargetPath = '${q(target)}'`,
    `$s.WorkingDirectory = '${q(path.dirname(target))}'`,
    `$s.IconLocation = '${q(target)},0'`,
    "$s.Description = 'DeskNest'",
    "$s.Save()"
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      (err) => resolve(!err));
  });
}

/* 第一次启动问一次：要不要放桌面、要不要开机自启。之后都在设置里改。 */
async function firstRunSetup() {
  const opts = {
    type: 'question',
    title: 'DeskNest 首次启动',
    message: '第一次使用 DeskNest，要不要先把它安顿好？',
    detail: '可以创建桌面快捷方式，并让它在开机时自动出现。\n以后随时能在设置里改。',
    buttons: ['创建桌面快捷方式 + 开机自启', '只创建桌面快捷方式', '先不用'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  };
  const r = (win && !win.isDestroyed())
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  if (r.response === 0 || r.response === 1) await createDesktopShortcut();
  if (r.response === 0) {
    try {
      app.setLoginItemSettings(loginItemOptions({ openAtLogin: true }));
      config.ui.startup = true;
      saveConfig();
    } catch { /* ignore */ }
  }
}

/* 第一次启动的卡片内容：只有一条「使用说明」，别的一概不自动进来。
   便携包里 使用说明.txt 就和启动器同目录（appRoot）；开发态没有这个文件，就不塞。 */
async function seedWelcomeItem(items) {
  if (!FIRST_RUN) return;
  const readme = path.join(appRoot(), '使用说明.txt');
  if (!fs.existsSync(readme)) return;
  const [it] = await buildItems([readme]);
  if (!it) return;
  config.extras[it.path] = it;
  config.assign[it.path] = 'welcome';
  config.manual[it.path] = true;
  config.folders = [
    { id: 'welcome', name: '使用说明', color: '#8a94a6', order: -1, items: [it.path] }
  ];
  items.push(it);
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('nest:init', async () => {
    const t = Date.now();
    const items = await scanDesktop(true);
    timing(`scan(${items.length} 项)`);
    await seedWelcomeItem(items);
    const rec = reconcile(items);
    // 桌面图标显隐以注册表为准（用户可能右键桌面自己改过），不能只信上次存的配置
    const hiddenIcons = await readDesktopIconsHidden();
    config.ui.desktopIconsHidden = hiddenIcons;
    saveConfig();
    timing('init-done');
    if (process.env.NEST_TIMING === '1') {
      console.log(`[stats] scan=${Date.now() - t}ms items=${items.length} folders=${config.folders.length}`);
    }
    const state = {
      items,
      folders: config.folders,
      assign: config.assign,
      manual: config.manual,
      hidden: config.hidden,
      ui: config.ui,
      customIcons: config.customIcons,
      createdFolders: rec.created,
      desktopIconsHidden: hiddenIcons,
      cardBg: cardBgState(),
      userData: USER_DATA,
      configFile: CONFIG_FILE,
      iconCacheFile: ICON_CACHE_FILE
    };
    return state;
  });

  ipcMain.handle('nest:rescan', async () => {
    const items = await scanDesktop(true);
    const rec = reconcile(items);
    saveConfig();
    return {
      items, folders: config.folders,
      assign: config.assign, manual: config.manual, hidden: config.hidden,
      customIcons: config.customIcons,
      createdFolders: rec.created
    };
  });

  ipcMain.handle('nest:add-extras', async (_e, items) => {
    if (!Array.isArray(items) || !items.length) return { ok: false };
    const placed = new Set();
    for (const f of config.folders) for (const p of f.items) placed.add(p);
    for (const it of items) {
      if (!it || !it.path) continue;
      config.extras[it.path] = {
        path: it.path, name: it.name, rawName: it.rawName, type: it.type,
        source: 'manual', mtime: it.mtime, size: it.size,
        target: it.target || '', iconSrc: it.iconSrc || '', icon: it.icon || ''
      };
      config.hidden = config.hidden.filter(p => p !== it.path);
      if (placed.has(it.path)) continue;
      const catKey = classify(it);
      let folder = config.folders.find(f => f.catKey === catKey);
      if (!folder) {
        folder = {
          id: 'cat_' + catKey,
          name: CATEGORY_META[catKey].name,
          color: CATEGORY_META[catKey].color,
          catKey,
          order: CATEGORY_ORDER.indexOf(catKey),
          items: []
        };
        config.folders.push(folder);
      }
      folder.items.push(it.path);
      config.assign[it.path] = folder.id;
      config.manual[it.path] = true;
      placed.add(it.path);
    }
    saveConfig();
    return { ok: true, folders: config.folders };
  });

  ipcMain.handle('nest:save-config', async (_e, patch) => {
    if (!patch || typeof patch !== 'object') return false;
    if (Array.isArray(patch.folders)) config.folders = patch.folders;
    if (patch.assign) config.assign = patch.assign;
    if (patch.manual) config.manual = patch.manual;
    if (patch.hidden) config.hidden = patch.hidden;
    if (patch.ui) {
      // 渲染层 persist 带上来的是它启动时那份 ui 快照，下面这些键都由主进程或专用接口维护，
      // 合并回去会用陈旧值覆盖真实状态：
      //   cardBg           — 卡片背景接口维护（否则「重启后背景丢了」）
      //   alwaysOnTop      — 设置开关和托盘菜单两处都能改，托盘改完不会通知渲染层；
      //                      渲染层抱着的旧 true 一旦被 persist 写回，窗口下次 show/restore
      //                      就会按配置重新系统置顶，表现就是「卡片一直压在其他软件上面」
      //   window           — 主进程按真实 bounds 记录（否则窗口坐标被旧值覆盖）
      //   collapsed / startup / desktopIconsHidden — 各有专用接口，同理不回写
      const ui = Object.assign({}, patch.ui);
      delete ui.cardBg;
      delete ui.alwaysOnTop;
      delete ui.window;
      delete ui.collapsed;
      delete ui.startup;
      delete ui.desktopIconsHidden;
      config.ui = Object.assign({}, config.ui, ui);
    }
    saveConfig();
    return true;
  });

  ipcMain.handle('nest:launch', async (_e, item) => {
    if (!item || !item.path) return { ok: false, error: 'no-path' };
    try {
      // 网址条目：不管渲染层传上来的 type 是什么，path / target 是 http(s) 就走浏览器
      const url = item.type === TYPE.URL ? (item.target || item.path)
        : (isUrlPath(item.path) ? item.path : (isUrlPath(item.target) ? item.target : ''));
      if (url) {
        await shell.openExternal(url);
        return { ok: true };
      }
      const err = await shell.openPath(item.path);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle('nest:reveal', async (_e, item) => {
    if (!item || !item.path) return false;
    if (item.type === TYPE.URL || isUrlPath(item.path)) return false;   // 网址没有可定位的磁盘位置
    try {
      if (item.type === TYPE.DIR) shell.openPath(item.path);
      else shell.showItemInFolder(item.path);
      return true;
    } catch { return false; }
  });

  ipcMain.handle('nest:pick-apps', async () => {
    if (!win) return [];
    const res = await dialog.showOpenDialog(win, {
      title: '添加应用',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '应用与快捷方式', extensions: ['lnk', 'exe', 'url', 'appref-ms', 'bat', 'cmd'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return [];
    return buildItems(res.filePaths);
  });

  ipcMain.handle('nest:scan-apps', async () => {
    const items = await scanInstalledApps();
    return { ok: true, items };
  });

  /* ---- 卡片背景：Wallpaper Engine 壁纸库 / 自选本地图片 ---- */
  ipcMain.handle('nest:list-wallpapers', async () => {
    return { ok: true, items: await listWallpapers() };
  });

  ipcMain.handle('nest:set-card-bg', async (_e, payload) => {
    if (!payload || typeof payload.file !== 'string' || !payload.file) return { ok: false };
    let file = payload.file;
    // 视频壁纸：静态预览只有 192×192，铺满卡片必糊 → 先从壁纸本体抽一帧再当背景
    if (payload.kind === 'we' && typeof payload.video === 'string' && payload.video) {
      try {
        const frame = await extractVideoFrame(payload.video);
        if (frame) file = frame;
      } catch { /* 抽帧失败就退回预览图，至少能用 */ }
    }
    if (!BG_IMAGE_EXT.has(path.extname(file).toLowerCase())) return { ok: false, error: 'bad-ext' };
    if (!bgUrlFor(file)) return { ok: false, error: 'missing' };
    config.ui.cardBg = {
      kind: payload.kind === 'we' ? 'we' : 'image',
      file,
      video: typeof payload.video === 'string' ? payload.video : '',
      name: String(payload.name || path.basename(file))
    };
    saveConfig();
    return { ok: true, bg: cardBgState() };
  });

  ipcMain.handle('nest:pick-bg-image', async () => {
    if (!win) return { ok: false };
    const res = await dialog.showOpenDialog(win, {
      title: '选择卡片背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    const file = res.filePaths[0];
    if (!BG_IMAGE_EXT.has(path.extname(file).toLowerCase())) return { ok: false, error: 'bad-ext' };
    bgUrlFor(file);
    config.ui.cardBg = { kind: 'image', file, name: path.basename(file) };
    saveConfig();
    return { ok: true, bg: cardBgState() };
  });

  ipcMain.handle('nest:clear-card-bg', async () => {
    config.ui.cardBg = null;
    saveConfig();
    return { ok: true, bg: null };
  });

  // 单独挑文件夹：Windows 的文件对话框不能同时选文件和文件夹，
  // 只给 openFile 时用户只能一层层点进文件夹内部，这里必须用 openDirectory。
  ipcMain.handle('nest:pick-folders', async () => {
    if (!win) return [];
    const res = await dialog.showOpenDialog(win, {
      title: '添加文件夹',
      properties: ['openDirectory', 'multiSelections']
    });
    if (res.canceled || !res.filePaths.length) return [];
    return buildItems(res.filePaths);
  });

  // 拖拽添加：渲染层只传路径（File.path 在 Electron 32+ 已移除，用 webUtils 取）
  ipcMain.handle('nest:add-paths', async (_e, paths) => {
    if (!Array.isArray(paths) || !paths.length) return [];
    return buildItems(paths.filter(p => typeof p === 'string' && p));
  });

  ipcMain.handle('nest:desktop-icons-state', async () => {
    const hidden = await readDesktopIconsHidden();
    return { hidden };
  });

  // 右键换图标：把用户选的图片复制进 iconcache，配置里记住映射（应用/文件夹/网站通用）
  ipcMain.handle('nest:pick-icon', async (_e, itemPath) => {
    if (!win || !itemPath || typeof itemPath !== 'string') return { ok: false };
    const exts = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'];
    const res = await dialog.showOpenDialog(win, {
      title: '选择图标图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: exts }]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    const src = res.filePaths[0];
    const ext = path.extname(src).toLowerCase();
    if (!exts.includes(ext.slice(1))) return { ok: false };
    try {
      fs.mkdirSync(ICON_DIR, { recursive: true });
      const hash = crypto.createHash('sha1')
        .update(src.toLowerCase() + '|' + Date.now() + '|' + Math.random())
        .digest('hex').slice(0, 32);
      const name = 'custom-' + hash + ext;
      fs.copyFileSync(src, path.join(ICON_DIR, name));
      config.customIcons[itemPath] = name;
      if (config.extras[itemPath]) config.extras[itemPath].icon = 'nest-icon://icon/' + name;
      saveConfig();
      return { ok: true, url: 'nest-icon://icon/' + name, file: name };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });

  // 恢复默认图标：删映射，再按条目本身重新走一次系统图标提取
  ipcMain.handle('nest:reset-icon', async (_e, item) => {
    if (!item || !item.path) return { ok: false };
    const p = item.path;
    const had = config.customIcons[p];
    delete config.customIcons[p];
    const probe = {
      path: p,
      type: item.type,
      target: item.target || '',
      mtime: item.mtime,
      size: item.size,
      icon: ''
    };
    await ensureIcons([probe], { prune: false });
    if (config.extras[p]) config.extras[p].icon = probe.icon || '';
    saveConfig();
    if (had) { try { fs.unlinkSync(path.join(ICON_DIR, had)); } catch { /* ignore */ } }
    return { ok: true, icon: probe.icon || '' };
  });

  ipcMain.handle('nest:backdrop', async (_e, refresh) => {
    if (refresh) {
      // 异步预先抓取：渲染层在形变之前"预下单"，等形变完直接拿新图，不卡那一下
      if (!backdropPromise) {
        backdropPromise = captureBackdrop().finally(() => { backdropPromise = null; });
      }
      return backdropCache;
    }
    if (backdropPromise) await backdropPromise;      // 等待在飞的抓取完成
    if (!backdropCache) await captureBackdrop();
    return backdropCache;
  });

  // 渲染层报告"圆钮是否该藏着"（窗口被别的软件盖住时为 true）。只在开 NEST_TIMING 时打日志。
  ipcMain.handle('nest:asleep', async (_e, asleep) => {
    if (process.env.NEST_TIMING === '1') console.log('[nest] asleep=' + asleep);
    return true;
  });

  ipcMain.handle('nest:toggle-desktop-icons', async (_e, hidden) => {
    if (process.env.NEST_TIMING === '1') console.log('[nest] toggle-desktop-icons hidden=' + JSON.stringify(hidden));
    const res = await applyDesktopIconsVisible(!hidden);
    config.ui.desktopIconsHidden = res.hidden;
    saveConfig();
    return res;
  });

  ipcMain.handle('nest:set-always-on-top', async (_e, flag) => {
    if (!win || win.isDestroyed()) return { on: false };
    config.ui.alwaysOnTop = !!flag;
    applyTopmost();
    saveConfig();
    sendWinState();
    updateTrayMenu();
    return { on: win.isAlwaysOnTop() };
  });

  // 点击穿透兜底：窗口若被系统/历史状态置成 ignore，这里强制恢复并激活
  ipcMain.handle('nest:focus', async () => {
    if (!win || win.isDestroyed()) return false;
    win.setIgnoreMouseEvents(false);
    if (!win.isVisible()) win.show();
    win.focus();
    return true;
  });

  // 设置里的卡片长宽：直接改窗口像素尺寸，右下角不动，越界自动拉回工作区
  ipcMain.handle('nest:set-size', async (_e, size) => {
    if (!win || win.isDestroyed() || !size) return null;
    const wa = screen.getPrimaryDisplay().workArea;
    const MIN = { w: 460, h: 320 };
    const b = win.getBounds();
    const width = Math.min(Math.max(Math.round(size.width), MIN.w), wa.width - 24);
    const height = Math.min(Math.max(Math.round(size.height), MIN.h), wa.height - 24);
    const x = Math.min(Math.max(b.x, wa.x + 12), wa.x + wa.width - width - 12);
    const y = Math.min(Math.max(b.y, wa.y + 12), wa.y + wa.height - height - 12);
    win.setBounds({ x, y, width, height });
    config.ui.window = { x, y, width, height };
    saveConfig();
    return { x, y, width, height };
  });

  ipcMain.handle('nest:startup', async (_e, flag) => {
    app.setLoginItemSettings(loginItemOptions({ openAtLogin: !!flag }));
    config.ui.startup = !!flag;
    saveConfig();
    return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
  });
  ipcMain.handle('nest:get-startup', async () => {
    return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
  });

  ipcMain.handle('nest:window', async (_e, action) => {
    if (!win || win.isDestroyed()) return false;
    // 只 hide，不再 minimize()+hide() 叠加：叠加会让窗口同时处于「最小化 + 隐藏」，
    // 隐藏期间渲染进程被节流，窗口状态非常规，再打开时容易停在还原不彻底的状态。
    if (action === 'minimize') win.hide();
    else if (action === 'hide') win.hide();
    else if (action === 'close') { quitting = true; win.close(); app.quit(); }
    else if (action === 'toggle') { toggleWindow(); return; }
    return true;
  });

  ipcMain.handle('nest:open-path', async (_e, p) => {
    try { await shell.openPath(p); return true; } catch { return false; }
  });

  ipcMain.handle('nest:set-collapsed', async (_e) => false);   // 永远展开模式

  // 窗口缩放：拖拽四边四角时逐像素调整尺寸（mousemove 实时调，不等松手）
  ipcMain.handle('nest:resize', async (_e, edge, dx, dy) => {
    if (!win || win.isDestroyed() || !dx && !dy) return;
    const b = win.getBounds();
    const MIN = { w: 460, h: 320 };
    const dxR = Math.round(dx), dyR = Math.round(dy);
    if (edge.includes('e')) b.width  = Math.max(MIN.w, b.width  + dxR);
    if (edge.includes('w')) { const ow = b.width; b.width = Math.max(MIN.w, b.width - dxR); b.x -= (b.width - ow); }
    if (edge.includes('s')) b.height = Math.max(MIN.h, b.height + dyR);
    if (edge.includes('n')) { const oh = b.height; b.height = Math.max(MIN.h, b.height - dyR); b.y -= (b.height - oh); }
    try { win.setBounds(b); } catch {}
  });

  ipcMain.handle('nest:win-state', async () => {
    if (!win || win.isDestroyed()) return null;
    return {
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      focused: win.isFocused(),
      alwaysOnTop: win.isAlwaysOnTop(),
      collapsed: config.ui.collapsed !== false
    };
  });
}

// ---------------------------------------------------------------- 生命周期
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    revealWindow();          // 再双击一次 exe：必须真的抬到最前，否则第一下点击会落到别的窗口
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('DeskNest');   // 任务栏分组/固定用我们自己的图标
    loadIconCache();
    config = loadConfig();

    /* 真实系统图标 / 用户自选图标走自定义协议：
       允许 iconcache 里的 <hash>.png，以及右键换图标复制进来的 custom-<hash>.<图片后缀> */
    protocol.handle('nest-icon', (req) => {
      try {
        const u = new URL(req.url);
        // 卡片背景图：只认主进程登记过的 token，渲染层拿不到任意路径
        if (u.hostname === 'bg') {
          const abs = bgFiles.get(u.pathname.replace(/^\/+/, ''));
          if (!abs) return new Response('bad bg', { status: 404 });
          const ext = path.extname(abs).toLowerCase();
          const mime = BG_MIME[ext] || 'application/octet-stream';
          /* 视频壁纸直接拿 mp4/webm 当卡片背景（原生分辨率，比抽帧更清晰，而且是动的）。
             Chromium 播视频必须能按字节分段读（Range/206），否则 4K 大文件要么一直缓冲、
             要么 seek 不动；net.fetch 不转 206，所以这里自己按 Range 开文件流。 */
          const range = req.headers.get('range');
          let st = null;
          try { st = fs.statSync(abs); } catch { return new Response('bad bg', { status: 404 }); }
          if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
            if (m) {
              const size = st.size;
              let start;
              let end;
              if (!m[1]) {                       // bytes=-N：最后 N 字节
                start = Math.max(0, size - (Number(m[2]) || 0));
                end = size - 1;
              } else {
                start = Number(m[1]);
                end = m[2] ? Number(m[2]) : size - 1;
              }
              if (!isFinite(start) || !isFinite(end) || start > end || start >= size) {
                return new Response('bad range', { status: 416, headers: { 'content-range': `bytes */${size}` } });
              }
              end = Math.min(end, size - 1);
              const body = Readable.toWeb(fs.createReadStream(abs, { start, end }));
              return new Response(body, {
                status: 206,
                headers: {
                  'content-type': mime,
                  'accept-ranges': 'bytes',
                  'content-range': `bytes ${start}-${end}/${size}`,
                  'content-length': String(end - start + 1),
                  'access-control-allow-origin': '*',
                  'cache-control': 'no-cache'
                }
              });
            }
          }
          return net.fetch(pathToFileURL(abs).toString()).then(res => new Response(res.body, {
            status: 200,
            headers: {
              'content-type': mime,
              'accept-ranges': 'bytes',
              'access-control-allow-origin': '*',
              'cache-control': 'no-cache'
            }
          }));
        }
        const name = u.pathname.replace(/^\/+/, '');
        if (!/^(?:[a-f0-9]{8,64}\.png|custom-[a-f0-9]{8,64}\.(?:png|jpe?g|webp|gif|bmp|ico))$/i.test(name)) {
          return new Response('bad name', { status: 400 });
        }
        const full = path.join(ICON_DIR, name);
        if (!full.startsWith(ICON_DIR)) return new Response('bad path', { status: 400 });
        const ext = path.extname(name).toLowerCase();
        const mime = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.ico': 'image/x-icon'
        }[ext] || 'image/png';
        return net.fetch(pathToFileURL(full).toString()).then(res => new Response(res.body, {
          status: 200,
          headers: {
            'content-type': mime,
            'access-control-allow-origin': '*',   // 让渲染层能从图标里取主色（canvas 不跨域污染）
            'cache-control': 'no-cache'
          }
        }));
      } catch {
        return new Response('err', { status: 500 });
      }
    });

    registerIpc();
    createWindow();
    createTray();

    // 第一次启动：等窗口真正出来（ready-to-show 后约 1s）再问，避免对话框比窗口先出现
    if (FIRST_RUN) {
      setTimeout(() => { firstRunSetup().catch(() => {}); }, 1000);
    }

    // 开机自启：上次开着就重写一遍注册表项。
    // 旧版本写进去的只有 electron.exe、不带项目路径，登录后只会起一个空 Electron，
    // 桌面卡片根本不出现 —— 这里每次启动都纠正成带参数的命令。
    if (config.ui && config.ui.startup) {
      try { app.setLoginItemSettings(loginItemOptions({ openAtLogin: true })); } catch { /* ignore */ }
    }

    globalShortcut.register(SHORTCUT, toggleWindow);

    // 状态校正：注册表与上次记录不一致时以后者为准（比如用户右键改过）
    readDesktopIconsHidden().then(h => {
      config.ui.desktopIconsHidden = h;
      saveConfig();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else revealWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!tray) app.quit();      // 有托盘就常驻，关闭窗口只隐藏
  });

  app.on('before-quit', () => {
    quitting = true;
    stopBackdropStream();
    if (config) {
      if (win && !win.isDestroyed() && config.ui.collapsed === false) {
        const b = win.getNormalBounds();
        config.ui.window = { x: b.x, y: b.y, width: b.width, height: b.height };
      }
      saveConfig();
    }
    if (iconCacheTimer) { clearTimeout(iconCacheTimer); iconCacheTimer = null; }
    if (iconCacheDirty) {
      try { writeJsonAtomic(ICON_CACHE_FILE, iconCache); } catch { /* ignore */ }
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}