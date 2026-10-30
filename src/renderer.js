'use strict';
/* ============================================================================
   DeskNest · 渲染进程 v3（白色毛玻璃 / 手机文件夹入口 / 手机式分页）
   ----------------------------------------------------------------------------
   约束（与主进程一致）：
     · 零框架、零构建；只通过 window.nest 白名单调用系统能力
     · 零 setInterval / 零 rAF 常驻：动效全交给 CSS，一次性动效用 setTimeout
     · 图标不在 IPC 里搬：item.icon 是 nest-icon://icon/<hash>.png，按需加载
     · 分批挂载节点，避免一次插入上千 DOM
   ============================================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ------------------------------------------------------------------ 小工具 */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const timers = new Set();
function once(fn, ms) {
  const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
  timers.add(id);
  return id;
}
function clearTimers() { for (const id of timers) clearTimeout(id); timers.clear(); }

/* 窗口正在被拖拽改尺寸：临时关掉最贵的重绘项（颗粒噪点/过渡），停手后自动恢复。
   透明窗口每改一次 bounds 都要整面板重画，噪点叠 mix-blend-mode 是掉帧的主因。 */
let morphTimer = null;
let morphHold = false;   /* 拖动滑块期间锁定：不让 240/500ms 的兜底定时器中途解除 */
function touchMorph(ms = 240) {
  if (!document.body.classList.contains('morphing')) pinPageGrid();
  document.body.classList.add('morphing');
  if (morphTimer) clearTimeout(morphTimer);
  morphTimer = setTimeout(() => {
    morphTimer = null;
    if (!morphHold) document.body.classList.remove('morphing');
  }, ms);
}
function startMorph() {
  if (!document.body.classList.contains('morphing')) pinPageGrid();
  morphHold = true;
  document.body.classList.add('morphing');
  if (morphTimer) { clearTimeout(morphTimer); morphTimer = null; }
}
function endMorph(delay = 160) {
  morphHold = false;
  if (morphTimer) { clearTimeout(morphTimer); morphTimer = null; }
  morphTimer = setTimeout(() => {
    morphTimer = null;
    if (!morphHold) document.body.classList.remove('morphing');
  }, delay);
}
function markMorphing(ms = 240) { touchMorph(ms); }
/* 记下当前页的列数与列宽，形变期间交给 CSS 锁死：
   否则每改一次卡片宽度，auto-fill 网格都会整页重新换行 + 所有图标横移重绘。
   只在形变开始时量一次，用的是"拖之前"的真实布局，锁定后图标原地不动。
   必须逐页记录 —— 每页的列数不一定相同，只锁第一页的话其余页面仍会重排。 */
function pinPageGrid() {
  for (const pg of document.querySelectorAll('.page')) {
    const tracks = getComputedStyle(pg).gridTemplateColumns;
    if (!tracks || tracks === 'none') continue;
    const list = tracks.split(' ');
    if (!list.length) continue;
    pg.style.setProperty('--pin-cols', String(list.length));
    pg.style.setProperty('--pin-track', list[0]);
  }
}

/** 分批挂载：每批 40 个，让出主线程，避免一次性布局上千节点 */
function mountChunked(host, nodes, chunk = 40) {
  let i = 0;
  const token = Symbol('batch');
  S.batchTokens.add(token);
  const step = () => {
    if (!S.batchTokens.has(token)) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(i + chunk, nodes.length);
    for (; i < end; i++) frag.appendChild(nodes[i]);
    host.appendChild(frag);
    if (i < nodes.length) once(step, 0);
    else S.batchTokens.delete(token);
  };
  step();
}
function basename(p) {
  const s = String(p);
  return s.slice(Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')) + 1);
}

/* ------------------------------------------------------------- 图标主色取色 */
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s, l };
}
const TINT_FALLBACK = '#2f7cff';
const tintCache = new Map();
const tintWaiters = new Map();

function paintTint(node, color) {
  if (!node || !node.style) return;
  node.style.setProperty('--tint', color || TINT_FALLBACK);
}
function requestTint(item, node) {
  paintTint(node, TINT_FALLBACK);
  if (!item || !item.icon) return;
  const key = item.icon;
  if (tintCache.has(key)) { paintTint(node, tintCache.get(key)); return; }
  if (!tintWaiters.has(key)) tintWaiters.set(key, []);
  tintWaiters.get(key).push(node);
  if (tintWaiters.get(key).length === 1) extractTint(item);
}
/* 取色用的 24×24 canvas 全局复用一张（64 个图标若各建一张，Chrome 会留下几十个 GPU canvas） */
let tintCanvas = null;
function extractTint(item) {
  const img = new Image();
  img.crossOrigin = 'anonymous';       // 图标走 nest-icon: 协议，取色需要 CORS 放行
  img.onload = () => {
    let color = TINT_FALLBACK;
    try {
      if (!tintCanvas) {
        tintCanvas = document.createElement('canvas');
        tintCanvas.width = 24; tintCanvas.height = 24;
      }
      const ctx = tintCanvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, 24, 24);
      ctx.drawImage(img, 0, 0, 24, 24);
      const d = ctx.getImageData(0, 0, 24, 24).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        if (a < 60) continue;
        const mx = Math.max(d[i], d[i + 1], d[i + 2]);
        const mn = Math.min(d[i], d[i + 1], d[i + 2]);
        if (mx > 246 && mn > 226) continue;     // 近白
        if (mx < 30) continue;                  // 近黑
        if (mx - mn < 16) continue;             // 灰
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
      if (n > 8) {
        const hsl = rgb2hsl(r / n, g / n, b / n);
        const s = Math.max(hsl.s, 0.58);
        const l = 0.56;
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const hk = hsl.h / 360;
        const to = (t) => {
          t = (t + 1) % 1;
          if (t < 1 / 6) return p + (q - p) * 6 * t;
          if (t < 1 / 2) return q;
          if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
          return p;
        };
        const rr = Math.round(to(hk + 1 / 3) * 255);
        const gg = Math.round(to(hk) * 255);
        const bb = Math.round(to(hk - 1 / 3) * 255);
        color = `rgb(${rr},${gg},${bb})`;
      }
    } catch { /* 跨域/解码失败 → 用兜底色 */ }
    tintCache.set(item.icon, color);
    const waiters = tintWaiters.get(item.icon) || [];
    tintWaiters.delete(item.icon);
    for (const node of waiters) if (node.isConnected) paintTint(node, color);
  };
  img.onerror = () => {
    const waiters = tintWaiters.get(item.icon) || [];
    tintWaiters.delete(item.icon);
    for (const node of waiters) if (node.isConnected) paintTint(node, TINT_FALLBACK);
  };
  img.src = item.icon;
}

/* ------------------------------------------------------------------ 状态 */
const PAGE_COLORS = ['#2f7cff', '#22c6ff', '#35d07f', '#8b6cff', '#ff7ba9', '#ffa93b', '#ff5d73', '#12b8a6'];

const S = {
  items: new Map(),
  pages: [],
  assign: {}, manual: {}, hidden: [], ui: {},
  customIcons: {},
  index: 0,
  query: '',
  collapsed: false,
  hideIcons: false,
  alwaysOnTop: false,
  startup: false,
  glassOpacity: 80,
  borderHue: 0,
  borderWidth: 0.3,
  textHue: 0,
  cardBg: null,
  userData: '', configFile: '', iconCount: 0,
  drag: null,
  selecting: false,
  picked: new Set(),
  animateIn: true,
  animNow: false,
  tileIndex: 0,
  batchTokens: new Set(),
  asleep: null,
  backdrop: ''
};

const itemsOf = (page) => (page.items || []).map(p => S.items.get(p) || {
  path: p, name: basename(p).replace(/\.(lnk|url|exe|appref-ms)$/i, ''), rawName: basename(p),
  icon: '', type: /^https?:\/\//i.test(p) ? 'url' : 'file', target: /^https?:\/\//i.test(p) ? p : ''
});

/* ------------------------------------------------------------------ 持久化 */
let persistTimer = null;
function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 320);
}
function persistNow() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  return window.nest.saveConfig({
    folders: S.pages, assign: S.assign, manual: S.manual, hidden: S.hidden, ui: S.ui
  }).catch(() => {});
}

/* 卡片边框颜色：0 = 默认白色；1~360 = 色相。只改 .glass 的 1px 描边，不动其它发光/阴影。 */
function applyBorderHue(h) {
  const hue = Number(h) || 0;
  const root = document.documentElement;
  if (!hue) root.style.removeProperty('--glass-border');
  else root.style.setProperty('--glass-border', `hsla(${hue}, 85%, 62%, 0.85)`);
  const input = $('#sliderBorder');
  if (input) {
    input.value = hue;
    input.style.setProperty('--border-preview', hue ? `hsl(${hue}, 85%, 62%)` : '#ffffff');
  }
  const label = $('#borderHueVal');
  if (label) label.textContent = hue ? hue + '°' : '白色（默认）';
}

/* 背景透明度：滑条语义是「透明度」——100% = 完全透（卡片看不见），0% = 完全不透。
   CSS 的 --glass-opacity 是「不透明度」（1 = 不透明），所以这里必须做一次 100 - t 的换算。
   直接把 t/100 写进去就是这个功能最早写反的原因：100% 变全白、0% 变全透。 */
function applyGlassOpacity(t) {
  const v = Math.max(0, Math.min(100, Number(t) || 0));
  document.documentElement.style.setProperty('--glass-opacity', ((100 - v) / 100).toFixed(2));
  const input = $('#sliderOpacity');
  if (input) input.value = v;
  const label = $('#opacityVal');
  if (label) label.textContent = v + '%';
}

/* 卡片边框厚度：单位毫米（CSS 的 1 mm = 96/25.4 ≈ 3.78 px），0 = 完全没有边框。
   只改 .glass 的 border-width：边框占的是 border-box 内侧，所以加厚等于「往卡片里嵌一圈画框」，
   内容区跟着向内收，不会把卡片外框撑大。 */
function applyBorderWidth(mm) {
  const v = Math.max(0, Math.min(5, Number(mm) || 0));
  const px = Math.round(v * 96 / 25.4 * 100) / 100;
  document.documentElement.style.setProperty('--glass-w', px + 'px');
  const input = $('#sliderBorderWidth');
  if (input) input.value = v;
  const label = $('#borderWidthVal');
  if (label) label.textContent = v ? v.toFixed(1) + ' mm' : '无边框';
}

/* 卡片字体颜色：0 = 默认墨色；1~360 = 色相。
   只换三级文字色，不改图标/背景。饱和度与明度固定，保证任意色相都还能读清：
   主文字 30% 明度、次级 39%、弱化 58%。 */
function applyTextHue(h) {
  const hue = Number(h) || 0;
  const root = document.documentElement;
  if (!hue) {
    root.style.removeProperty('--ink');
    root.style.removeProperty('--ink-2');
    root.style.removeProperty('--ink-3');
  } else {
    root.style.setProperty('--ink', `hsl(${hue}, 38%, 30%)`);
    root.style.setProperty('--ink-2', `hsl(${hue}, 38%, 39%)`);
    root.style.setProperty('--ink-3', `hsl(${hue}, 26%, 58%)`);
  }
  const input = $('#sliderText');
  if (input) {
    input.value = hue;
    input.style.setProperty('--ink-preview', hue ? `hsl(${hue}, 38%, 30%)` : '#3B3F52');
  }
  const label = $('#textHueVal');
  if (label) label.textContent = hue ? hue + '°' : '默认';
}

/* ------------------------------------------------------------------ Toast */
function toast(msg, kind) {
  const box = $('#toasts');
  const t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
  box.appendChild(t);
  while (box.children.length > 3) box.removeChild(box.firstChild);
  once(() => {
    t.classList.add('out');
    once(() => t.remove(), 240);
  }, 1900);
}

/* ------------------------------------------------------------------ 确认框 */
function dialog(opts) {
  return new Promise((resolve) => {
    const layer = $('#dlgLayer');
    $('#dlgTitle').textContent = opts.title || '确认';
    $('#dlgBody').textContent = opts.body || '';
    const wrap = $('#dlgInputWrap');
    const input = $('#dlgInput');
    if (opts.input != null) {
      wrap.hidden = false;
      input.value = opts.input;
    } else {
      wrap.hidden = true;
      input.value = '';
    }
    $('#dlgOk').textContent = opts.ok || '确定';
    const okBtn = $('#dlgOk');
    if (opts.danger) okBtn.classList.add('pill-danger');
    layer.hidden = false;
    void layer.offsetWidth;              // 强制重排，让 transition 从初始态开始
    layer.classList.add('show');
    if (opts.input != null) once(() => { input.focus(); input.select(); }, 60);

    const done = (val) => {
      layer.classList.remove('show');
      once(() => { layer.hidden = true; }, 220);
      okBtn.onclick = null; $('#dlgCancel').onclick = null;
      layer.onclick = null; input.onkeydown = null;
      resolve(val);
    };
    okBtn.onclick = () => done(opts.input != null ? (input.value.trim() || opts.input) : true);
    $('#dlgCancel').onclick = () => done(null);
    layer.onclick = (e) => { if (e.target === $('#dlgMask')) done(null); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); okBtn.onclick(); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
  });
}

/* ---------------------------------------------------------------- 右键菜单 */
function closeCtx() {
  const c = $('#ctx');
  c.hidden = true;
  c.textContent = '';
}
function openCtx(x, y, entries) {
  const c = $('#ctx');
  c.textContent = '';
  for (const it of entries) {
    if (it.head) { c.appendChild(el('div', 'ctx-head', it.head)); continue; }
    if (it.sep) { c.appendChild(el('div', 'ctx-sep')); continue; }
    const row = el('div', 'ctx-item');
    row.appendChild(el('span', null, it.label));
    if (it.key) row.appendChild(el('span', 'key', it.key));
    row.onclick = () => { closeCtx(); it.run && it.run(); };
    c.appendChild(row);
  }
  c.hidden = false;
  const r = c.getBoundingClientRect();
  const host = $('#app').getBoundingClientRect();   // 菜单挂在 .app 里（20px 投影留边之外会被 overflow 裁掉）
  const maxX = host.width - r.width - 8;
  const maxY = host.height - r.height - 8;
  c.style.left = Math.max(8, Math.min(x - host.left, maxX)) + 'px';
  c.style.top = Math.max(8, Math.min(y - host.top, maxY)) + 'px';
}

/* ---------------------------------------------------------------- 启动 */
async function boot() {
  try {
    const data = await window.nest.init();
    adopt(data);
    S.collapsed = false;          // 永远展开模式
    applyMode();
    $('#chip').hidden = true;
    $('#main').hidden = false;
    applyCardBg(data.cardBg);
    renderAll();
    if (data.createdFolders && data.createdFolders.length) {
      toast(`已收纳 ${data.items.length} 个桌面项目 · ${S.pages.length} 页`);
    }
    applyAsleep();
    // 背景透明度：从上次关闭时保存的值恢复（80% = 默认，桌面透得出来但卡片上的字还清楚）
    applyGlassOpacity(S.glassOpacity);
    applyBorderHue(S.borderHue);
    applyBorderWidth(S.borderWidth);
    applyTextHue(S.textHue);
    // 开机自启状态：以系统实际注册为准（electron 在注册表里持久化）
    if (window.nest.getStartup) {
      window.nest.getStartup().then(v => { S.startup = !!v; }).catch(() => {});
    }
  } catch (e) {
    toast('初始化失败：' + (e && e.message ? e.message : e), 'warn');
  }
}

function adopt(data) {
  S.items = new Map((data.items || []).map(it => [it.path, it]));
  S.pages = (data.folders || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  S.assign = data.assign || {};
  S.manual = data.manual || {};
  S.hidden = Array.isArray(data.hidden) ? data.hidden : [];
  S.ui = data.ui || {};
  S.hideIcons = !!data.desktopIconsHidden;
  S.customIcons = data.customIcons || {};
  S.alwaysOnTop = !!(S.ui && S.ui.alwaysOnTop);
  S.startup = !!(S.ui && S.ui.startup);
  S.glassOpacity = (S.ui && S.ui.glassOpacity != null) ? S.ui.glassOpacity : 80;
  S.borderHue = (S.ui && S.ui.borderHue != null) ? S.ui.borderHue : 0;
  S.borderWidth = (S.ui && S.ui.borderWidth != null) ? S.ui.borderWidth : 0.3;
  S.textHue = (S.ui && S.ui.textHue != null) ? S.ui.textHue : 0;
  S.cardBg = data.cardBg || null;
  S.userData = data.userData || '';
  S.configFile = data.configFile || '';
  S.iconCount = new Set((data.items || []).map(i => i.icon).filter(Boolean)).size;
  S.index = Math.min(S.ui.pageIndex || 0, Math.max(0, S.pages.length - 1));
}

function renderAll() {
  renderChip();
  renderMain();
  renderSettingsState();
}

/* 背景：窗口本身就是真透明，背后直接是实时桌面/窗口。
   不再抓屏 —— 抓屏会把上一帧画面糊进玻璃里，关闭软件后旧图标还留在卡片上（背景残留）。 */
let backdropAt = 0;
async function applyBackdrop() { /* 真透明，无需任何背景图 */ }

/* ================================================== 只在桌面露出来时才现身（零轮询）
 * 别的软件盖住我们时，Chromium 会把文档标成 hidden（遮挡检测），
 * 于是我们淡出圆钮并让出拖动区；桌面重新露出来时再淡回来。纯事件驱动。 */
function applyAsleep() {
  const asleep = document.visibilityState === 'hidden' || document.hidden === true;
  if (asleep === S.asleep) return;
  const wasAsleep = S.asleep;
  S.asleep = asleep;
  document.body.classList.toggle('asleep', asleep);
  syncCardVideo();
  if (window.nest.asleep) window.nest.asleep(asleep).catch(() => {});
  // 从被盖住变回可见 + 面板展开中 → 用户最小化了某个软件 → 刷新背景消除残留
  if (wasAsleep && !asleep && !S.collapsed) applyBackdrop(true);
}

/* ================================================== 收起态：桌面上的白色圆钮 */
function renderChip() {
  const total = S.items.size;
  const btn = $('#chipFolder');
  btn.title = `DeskNest · ${S.pages.length} 页 · ${total} 个应用 —— 单击展开`;
  btn.setAttribute('aria-label', `展开 DeskNest（${total} 个应用）`);
}

/** 收起/展开的形态切换（圆形面板 vs 方形玻璃面板） */
function applyMode() {
  document.body.classList.toggle('collapsed', !!S.collapsed);
  document.body.classList.toggle('expanded', !S.collapsed);   // 面板白名单：只有展开态才画玻璃底
  syncCardVideo();
}

async function expand() { /* 永远展开模式，不再需要从小球展开 */ }
async function collapse() { window.nest.windowAction('minimize'); }

/* ================================================== 展开态：分页主界面 */
function currentPage() { return S.pages[S.index] || null; }

function renderMain() {
  const pages = $('#pages');
  pages.textContent = '';
  S.batchTokens.clear();
  S.animNow = !!S.animateIn;
  S.animateIn = false;
  S.tileIndex = 0;
  renderCardNum();

  const q = S.query.trim().toLowerCase();
  if (q) {
    const hits = [];
    for (const p of S.pages) for (const it of itemsOf(p)) {
      if (it.name.toLowerCase().includes(q) || (it.rawName || '').toLowerCase().includes(q)) hits.push([it, p.id]);
    }
    const page = el('div', 'page');
    page.dataset.id = '__search';
    pages.appendChild(page);
    mountChunked(page, hits.map(([it]) => itemTile(it)));
    $('#pageNameLabel').textContent = '搜索结果';
    $('#pageMeta').textContent = `${hits.length} 个应用`;
    $('#navPrev').classList.add('off');
    $('#navNext').classList.add('off');
    const box = $('#empty');
    box.hidden = hits.length > 0;
    if (!hits.length) {
      box.querySelector('.empty-title').textContent = '没找到相关应用';
      box.querySelector('.empty-sub').textContent = '换个关键词试试，清空搜索框就回到分页';
      $('#btnEmptyAdd').hidden = true;
    } else {
      $('#btnEmptyAdd').hidden = false;
    }
    pages.style.transform = 'translateX(0%)';
    return;
  }

  for (const p of S.pages) {
    const page = el('div', 'page');
    page.dataset.id = p.id;
    pages.appendChild(page);
    mountChunked(page, itemsOf(p).map(it => itemTile(it)));
  }
  pages.style.transform = `translateX(${-S.index * 100}%)`;

  const page = currentPage();
  $('#pageNameLabel').textContent = page ? page.name : '';
  $('#pageMeta').textContent = page ? `${itemsOf(page).length} 个应用` : '0 个应用';
  document.documentElement.style.setProperty('--page-color', (page && page.color) || 'var(--accent)');
  $('#navPrev').classList.toggle('off', S.index <= 0);
  $('#navNext').classList.toggle('off', S.index >= S.pages.length - 1);

  const box = $('#empty');
  box.hidden = !!(page && itemsOf(page).length);
  if (page && !itemsOf(page).length) {
    box.querySelector('.empty-title').textContent = '这一页还是空的';
    box.querySelector('.empty-sub').textContent = '用设置里的「添加应用」把人拉进来，或把别的页的图标拖过来';
    $('#btnEmptyAdd').hidden = false;
  }
  renderDots();
}

function itemTile(it) {
  const node = el('div', 'item');
  node.draggable = !S.selecting;
  node.title = it.rawName || it.name;
  node.dataset.path = it.path;

  const tile = el('div', 'tile');
  if (it.icon) {
    const img = el('img');
    img.src = it.icon;
    img.alt = '';
    img.draggable = false;
    img.loading = 'lazy';        // 不在视口里的页先不解码 256px 位图（省下大头内存）
    img.decoding = 'async';
    tile.appendChild(img);
  }
  node.appendChild(tile);
  node.appendChild(el('div', 'label', it.name));
  node.appendChild(el('span', 'pick', '✓'));
  if (S.selecting && S.picked.has(it.path)) node.classList.add('picked');

  if (S.animNow) {
    node.classList.add('enter');
    node.style.animationDelay = (S.tileIndex++ * 12) + 'ms';
  }
  requestTint(it, tile);

  node.addEventListener('dblclick', () => { if (!S.selecting) launch(it); });
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    if (S.selecting) togglePick(it.path);
  });
  node.addEventListener('contextmenu', (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    itemMenu(ev.clientX, ev.clientY, it);
  });
  node.addEventListener('dragstart', (ev) => {
    const host = node.closest('.page');
    S.drag = { path: it.path, node, pageId: host ? host.dataset.id : '', reorder: false };
    try { ev.dataTransfer.setData('text/plain', it.path); } catch { /* ignore */ }
    ev.dataTransfer.effectAllowed = 'move';
    node.classList.add('dragging');
    showMoveBar(it.name);
  });
  /* 页内拖拽排序：跟手机桌面一样，拖过谁就把自己插到它前/后半格 */
  node.addEventListener('dragover', (ev) => {
    const d = S.drag;
    if (!d || !d.node || d.node === node) return;
    const host = node.closest('.page');
    if (!host || host !== d.node.closest('.page') || host.dataset.id === '__search') return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const r = node.getBoundingClientRect();
    const after = ev.clientX >= r.left + r.width / 2;
    const parent = node.parentNode;
    if (!parent) return;
    parent.insertBefore(d.node, after ? node.nextSibling : node);
    d.reorder = true;
  });
  node.addEventListener('drop', (ev) => { if (S.drag && S.drag.node) ev.preventDefault(); });
  node.addEventListener('dragend', () => {
    node.classList.remove('dragging');
    const d = S.drag;
    S.drag = null;
    hideMoveBar();
    if (d && d.reorder) commitPageOrder(d.pageId);
  });
  return node;
}

/** 页内拖动结束后按 DOM 顺序回写 page.items（不重渲染，避免闪烁） */
function commitPageOrder(pageId) {
  if (!pageId || pageId === '__search') return;
  const page = S.pages.find(p => p.id === pageId);
  if (!page) return;
  const host = document.querySelector(`.page[data-id="${pageId}"]`);
  if (!host) return;
  const order = Array.from(host.querySelectorAll(':scope > .item')).map(n => n.dataset.path).filter(Boolean);
  if (!order.length) return;
  const before = (page.items || []).join('\u0000');
  page.items = order;
  if (page.items.join('\u0000') !== before) persistNow();
}

function renderDots() {
  // 底栏只保留左右两个小翻页箭头（不再画小蓝条/小灰条，也不放页码）
  $('#navPrev').classList.toggle('off', S.index <= 0);
  $('#navNext').classList.toggle('off', S.index >= S.pages.length - 1);
}

function goPage(i) {
  const next = Math.max(0, Math.min(i, S.pages.length - 1));
  if (next === S.index) return;
  S.index = next;
  S.ui.pageIndex = next;
  const pages = $('#pages');
  pages.style.transform = `translateX(${-S.index * 100}%)`;
  $('#navPrev').classList.toggle('off', S.index <= 0);
  $('#navNext').classList.toggle('off', S.index >= S.pages.length - 1);
  const page = currentPage();
  if (page) {
    $('#pageNameLabel').textContent = page.name;
    $('#pageMeta').textContent = `${itemsOf(page).length} 个应用`;
  }
  const empty = $('#empty');
  empty.hidden = !!(page && itemsOf(page).length);
  renderCardNum();
  persist();
}

/* 拖拽提示条 */
function showMoveBar(name) {
  $('#moveText').textContent = `移动「${name}」：拖到左右箭头 = 移到那一页`;
  $('#moveBar').hidden = false;
  const prev = $('#navPrev'), next = $('#navNext');
  prev.classList.add('drop-hot');
  next.classList.add('drop-hot');
  prev.ondragover = (e) => e.preventDefault();
  prev.ondrop = (e) => { e.preventDefault(); if (S.drag) moveItemToPage(S.drag.path, (S.pages[S.index - 1] || {}).id); };
  next.ondragover = (e) => e.preventDefault();
  next.ondrop = (e) => { e.preventDefault(); if (S.drag) moveItemToPage(S.drag.path, (S.pages[S.index + 1] || {}).id); };
}
function hideMoveBar() {
  $('#moveBar').hidden = true;
  $('#navPrev').classList.remove('drop-hot');
  $('#navNext').classList.remove('drop-hot');
}

/* ----------------------------------------------------------- 条目操作 */
async function launch(it) {
  const r = await window.nest.launch(it);
  if (r && r.ok === false) toast('打不开：' + (r.error || (it.type === 'url' ? '无效网址' : '文件已不存在')), 'warn');
}
async function reveal(it) { await window.nest.reveal(it); }
function copyPath(it) {
  const ta = el('textarea');
  ta.value = it.path;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('已复制路径'); } catch { toast('复制失败', 'warn'); }
  ta.remove();
}
function itemMenu(x, y, it) {
  const here = S.pages.find(p => p.id === S.assign[it.path]);
  const hasCustom = !!(S.customIcons && S.customIcons[it.path]);
  const entries = [
    { head: it.name },
    { label: '打开', key: '双击', run: () => launch(it) },
    { label: '在资源管理器中定位', run: () => reveal(it) },
    { label: '复制完整路径', run: () => copyPath(it) },
    { sep: true },
    { label: '更换图标…', run: () => pickIcon(it) }
  ];
  if (hasCustom) entries.push({ label: '恢复默认图标', run: () => resetIcon(it) });
  entries.push({ sep: true });
  // 单个移除和批量移除是两回事，两个入口都要在（单个在这里，批量在下面）
  entries.push({ label: '从本页移除', run: () => removeFromLibrary(it) });
  entries.push({ label: '批量移除…', run: () => startSelect() });
  entries.push({ sep: true });
  for (const p of S.pages) {
    if (here && p.id === here.id) continue;
    entries.push({ label: `移到「${p.name}」`, run: () => moveItemToPage(it.path, p.id) });
  }
  openCtx(x, y, entries);
}

/* --------------------------------------------------------- 自定义图标 */
async function pickIcon(it) {
  if (!window.nest.pickIcon) return;
  const r = await window.nest.pickIcon(it.path);
  if (!r || !r.ok) return;
  const rec = S.items.get(it.path);
  if (rec) rec.icon = r.url;
  S.customIcons[it.path] = r.file || true;
  renderMain();
  toast('图标已更换');
}
async function resetIcon(it) {
  if (!window.nest.resetIcon) return;
  const r = await window.nest.resetIcon(it);
  if (!r || !r.ok) return;
  const rec = S.items.get(it.path);
  if (rec) rec.icon = r.icon || '';
  delete S.customIcons[it.path];
  renderMain();
  toast('已恢复默认图标');
}

function moveItemToPage(path, toId) {
  S.drag = null;
  const to = S.pages.find(p => p.id === toId);
  if (!to) { hideMoveBar(); return; }
  const from = S.pages.find(p => (p.items || []).includes(path));
  if (from && from.id === to.id) { hideMoveBar(); toast('已经在这一页了'); return; }
  if (from) from.items = from.items.filter(p => p !== path);
  to.items.push(path);
  S.assign[path] = to.id;
  S.manual[path] = true;
  hideMoveBar();
  persistNow();
  renderAll();
  toast(`已移到「${to.name}」`);
}

/* ------------------------------------------------------- 批量移除 */
function startSelect() {
  S.selecting = true;
  S.picked.clear();
  updateSelBar();
  renderMain();
}
function endSelect() {
  S.selecting = false;
  S.picked.clear();
  updateSelBar();
  renderMain();
}
function togglePick(path) {
  if (S.picked.has(path)) S.picked.delete(path);
  else S.picked.add(path);
  updateSelBar();
  renderMain();
}
function updateSelBar() {
  const bar = $('#selBar');
  if (!bar) return;
  bar.hidden = !S.selecting;
  $('#selText').textContent = `已选 ${S.picked.size} 项`;
  $('#selRemove').disabled = S.picked.size === 0;
}
async function removePicked() {
  const n = S.picked.size;
  if (!n) return;
  const ok = await dialog({
    title: '批量移除',
    body: `从收纳库移除选中的 ${n} 个应用？（桌面上的文件本身不会被删除）`,
    ok: '移除', danger: true
  });
  if (!ok) return;
  for (const p of [...S.picked]) removePath(p);
  S.picked.clear();
  S.selecting = false;
  persistNow();
  updateSelBar();
  renderAll();
  toast(`已移除 ${n} 个应用`);
}

/** 从收纳库彻底移除一个路径（不落盘，调用方负责 persist） */
function removePath(path) {
  for (const p of S.pages) p.items = (p.items || []).filter(x => x !== path);
  delete S.assign[path];
  delete S.manual[path];
  if (!S.hidden.includes(path)) S.hidden.push(path);
  S.items.delete(path);
}

function removeFromLibrary(it) {
  removePath(it.path);
  persistNow();
  renderAll();
  toast('已从收纳库移除（重新扫描桌面会按分类回归）');
}

/* ----------------------------------------------------------- 分页管理 */
async function newPage() {
  const name = await dialog({ title: '新建页面', body: '给这一页起个名字，比如「学习」「游戏」', input: '新页面', ok: '创建' });
  if (!name) return;
  const id = 'page_' + Date.now().toString(36);
  S.pages.push({
    id, name,
    color: PAGE_COLORS[S.pages.length % PAGE_COLORS.length],
    order: S.pages.length,
    items: []
  });
  S.index = S.pages.length - 1;
  S.ui.pageIndex = S.index;
  persistNow();
  renderAll();
  toast(`已新建「${name}」`);
}
async function renamePage() {
  const page = currentPage();
  if (!page) return;
  const name = await dialog({ title: '重命名页面', input: page.name, ok: '保存' });
  if (!name || name === page.name) return;
  page.name = name;
  persistNow();
  renderAll();
}
async function deletePage() {
  const page = currentPage();
  if (!page) return;
  if (S.pages.length <= 1) { toast('至少要保留一页', 'warn'); return; }
  const n = itemsOf(page).length;
  const ok = await dialog({
    title: '删除页面',
    body: n
      ? `「${page.name}」里有 ${n} 个应用，删除后这些应用会一起从收纳库移除（桌面文件本身不删）。`
      : `确定删除空页面「${page.name}」？`,
    ok: '删除', danger: true
  });
  if (!ok) return;
  // 页面里的应用跟着页面一起删掉，不再搬到第一页
  for (const p of (page.items || []).slice()) removePath(p);
  S.pages = S.pages.filter(p => p.id !== page.id);
  S.pages.forEach((p, i) => { p.order = i; });
  S.index = Math.max(0, Math.min(S.index, S.pages.length - 1));
  S.ui.pageIndex = S.index;
  persistNow();
  renderAll();
  toast(n ? `已删除页面及其中的 ${n} 个应用` : '已删除页面');
}

async function addWeb() {
  const url = await dialog({ title: '添加网站', input: 'https://', ok: '添加', placeholder: 'https://...' });
  if (!url) return;
  let raw = url.trim();
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  const name = raw.replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0];
  const it = { path: raw, name, rawName: name, type: 'url', target: raw, icon: '' };
  // 关键：写进主进程的 config.extras 才能真正落盘。
  // 只塞进 S.items / pages 的话，重启后 scanDesktop 不会认识它，条目会退化成 type:'file' 且无图标。
  const res = await window.nest.addExtras([it]);
  if (res && res.folders) S.pages = res.folders.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  S.items.set(it.path, it);
  const page = currentPage() || S.pages[0];
  if (page) moveSilently(it.path, page.id);
  persistNow();
  renderAll();
  toast('已添加 ' + name);
}

async function addApps(kind) {
  const picked = kind === 'folder'
    ? (window.nest.pickFolders ? await window.nest.pickFolders() : [])
    : await window.nest.pickApps();
  if (!picked || !picked.length) return;
  await ingestItems(picked);
  toast(`已添加 ${picked.length} 个应用`);
}

/** 选好/拖进来的条目统一入库：写 extras + 放到当前页 */
async function ingestItems(picked) {
  const res = await window.nest.addExtras(picked);
  if (res && res.folders) S.pages = res.folders.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const page = currentPage() || S.pages[0];
  for (const it of picked) {
    S.items.set(it.path, it);
    if (page) moveSilently(it.path, page.id);
  }
  persistNow();
  renderAll();
}
function moveSilently(path, toId) {
  for (const p of S.pages) p.items = (p.items || []).filter(x => x !== path);
  const to = S.pages.find(p => p.id === toId);
  if (to) { to.items.push(path); S.assign[path] = to.id; S.manual[path] = true; }
}

/* ------------------------------------------- 扫描已安装软件（仅软件，不含文件夹/网站） */
const SCAN = { items: [], picked: new Set(), query: '', loading: false, open: false };

/** 已在收纳库里（按路径判断；扫描出来的是开始菜单快捷方式，和桌面快捷方式各自独立） */
function scannedHere(it) {
  if (S.items.has(it.path)) return true;
  return S.pages.some(p => (p.items || []).includes(it.path));
}

function scanVisible() {
  const q = SCAN.query.trim().toLowerCase();
  if (!q) return SCAN.items;
  return SCAN.items.filter(it =>
    it.name.toLowerCase().includes(q) || (it.target || '').toLowerCase().includes(q));
}

async function openScan() {
  closeCtx();
  const layer = $('#scanLayer');
  layer.hidden = false;
  void layer.offsetWidth;
  layer.classList.add('show');
  SCAN.open = true;
  SCAN.picked.clear();
  SCAN.query = '';
  $('#scanQuery').value = '';
  updateScanBar();
  if (SCAN.items.length) renderScanList();
  else await loadScan();
  once(() => { if (SCAN.open) $('#scanQuery').focus(); }, 90);
}

function closeScan() {
  const layer = $('#scanLayer');
  if (!layer || layer.hidden) return;
  SCAN.open = false;
  layer.classList.remove('show');
  once(() => { layer.hidden = true; }, 220);
}

async function loadScan() {
  const host = $('#scanList');
  host.textContent = '';
  host.appendChild(el('div', 'scan-state', '正在扫描电脑上已安装的软件…首次扫描需要几秒'));
  SCAN.loading = true;
  updateScanBar();
  try {
    const res = window.nest.scanApps ? await window.nest.scanApps() : null;
    SCAN.items = res && Array.isArray(res.items) ? res.items : [];
  } catch (e) {
    SCAN.items = [];
    toast('扫描失败：' + (e && e.message ? e.message : e), 'warn');
  }
  SCAN.loading = false;
  if (!SCAN.open) return;
  renderScanList();
}

function renderScanList() {
  const host = $('#scanList');
  host.textContent = '';
  const list = scanVisible();
  if (!list.length) {
    host.appendChild(el('div', 'scan-state plain', SCAN.query ? '没有匹配的软件' : '没有扫描到已安装的软件'));
    updateScanBar();
    return;
  }
  mountChunked(host, list.map(it => scanRow(it)), 60);
  updateScanBar();
}

function scanRow(it) {
  const row = el('div', 'scan-row');
  row.dataset.path = it.path;
  const here = scannedHere(it);

  row.appendChild(el('span', 'scan-check'));
  const tile = el('div', 'scan-tile');
  if (it.icon) {
    const img = el('img');
    img.src = it.icon;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    tile.appendChild(img);
  }
  row.appendChild(tile);

  const meta = el('div', 'scan-meta');
  meta.appendChild(el('div', 'scan-name', it.name));
  if (it.target) {
    const sub = el('div', 'scan-target', it.target);
    sub.title = it.target;
    meta.appendChild(sub);
  }
  row.appendChild(meta);

  const btn = el('button', 'pill scan-one', here ? '已添加' : '添加');
  btn.onclick = (ev) => {
    ev.stopPropagation();
    if (!scannedHere(it)) addScanned([it]);
  };
  row.appendChild(btn);

  if (here) {
    row.classList.add('added');
    btn.disabled = true;
  } else {
    row.onclick = () => toggleScan(it.path, row);
  }
  if (SCAN.picked.has(it.path)) row.classList.add('on');
  return row;
}

function toggleScan(path, row) {
  if (SCAN.picked.has(path)) SCAN.picked.delete(path);
  else SCAN.picked.add(path);
  if (row) row.classList.toggle('on', SCAN.picked.has(path));
  updateScanBar();
}

function toggleScanAll() {
  const list = scanVisible().filter(it => !scannedHere(it));
  if (!list.length) return;
  const all = list.every(it => SCAN.picked.has(it.path));
  for (const it of list) {
    if (all) SCAN.picked.delete(it.path);
    else SCAN.picked.add(it.path);
  }
  renderScanList();
}

function updateScanBar() {
  const n = SCAN.picked.size;
  $('#scanSel').textContent = SCAN.loading ? '扫描中…' : `已选 ${n} 项`;
  $('#scanAdd').disabled = SCAN.loading || n === 0;
  const list = scanVisible().filter(it => !scannedHere(it));
  const all = list.length > 0 && list.every(it => SCAN.picked.has(it.path));
  $('#scanAll').textContent = all ? '取消全选' : '全选';
  $('#scanAll').disabled = SCAN.loading || !list.length;
}

/** 单个添加 / 批量添加走同一条入库链路（写 extras + 落到当前页） */
async function addScanned(items) {
  const fresh = items.filter(it => !scannedHere(it));
  if (!fresh.length) return;
  const picked = fresh.map(it => ({
    path: it.path, name: it.name, rawName: it.rawName, type: it.type,
    target: it.target, iconSrc: it.iconSrc, mtime: it.mtime, size: it.size, icon: it.icon
  }));
  await ingestItems(picked);
  for (const it of fresh) SCAN.picked.delete(it.path);
  renderScanList();
  toast(`已添加 ${fresh.length} 个软件`);
}

/* ------------------------------------------- 卡片背景（Wallpaper Engine 壁纸 / 本地图片）
 * 背景图不进渲染层的 <img>：主进程把用户确认过的文件登记成 nest-icon://bg/<token>，
 * 这里只把 URL 塞给 .cardbg-img 的 background-image，再由 .glass 的 backdrop-filter 去糊它。 */
const BG = { items: [], query: '', loading: false, open: false, showAll: false };

/** 应用一份背景状态（来自主进程；null = 默认浅色底） */
function applyCardBg(bg) {
  S.cardBg = bg || null;
  const img = $('#cardbgImg');
  const url = S.cardBg && S.cardBg.url ? S.cardBg.url : '';
  if (img) img.style.backgroundImage = url ? `url("${url}")` : '';

  /* 动态壁纸：主进程直接把壁纸本体的 mp4/webm 登记成 URL 送过来。
     静态帧（url）留在下面当海报，视频首帧出来前先有画面，之后视频盖住它。 */
  const video = $('#cardbgVideo');
  const vurl = S.cardBg && S.cardBg.video ? S.cardBg.video : '';
  if (video) {
    if (vurl) {
      if (video.getAttribute('src') !== vurl) {
        video.setAttribute('src', vurl);
        video.load();
      }
    } else if (video.hasAttribute('src')) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }
  document.body.classList.toggle('has-cardbg', !!url);
  document.body.classList.toggle('has-cardvideo', !!vurl);
  syncCardVideo();
  renderCardNum();
}

/* 动态壁纸只在「卡片真的看得见」时播：收起、窗口隐藏、最小化全部暂停。
   4K 视频一直解码很吃电，卡片没人看的时候没必要跑。 */
function syncCardVideo() {
  const v = $('#cardbgVideo');
  if (!v || !v.hasAttribute('src')) return;
  const app = document.getElementById('app');
  const canPlay = document.body.classList.contains('has-cardvideo')
    && document.body.classList.contains('expanded')
    && !S.asleep
    && !(app && app.classList.contains('paused'));
  if (canPlay) {
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  } else {
    v.pause();
  }
}

/** 巨号深蓝页码（当前页 / 总页数）—— 玻璃要糊的「形状」之一 */
function renderCardNum() {
  const node = $('#cardbgNum');
  if (!node) return;
  const total = Math.max(1, S.pages.length);
  const cur = Math.max(1, Math.min(S.index + 1, total));
  node.textContent = String(cur);
  node.appendChild(el('span', null, ` / ${total}`));
}

function bgVisible() {
  // 默认只显示「我的壁纸」（Wallpaper Engine 里真正加载过的）。
  // 本机 workshop 里的订阅往往远多于用户自己的库，全量铺出来会全是陌生条目。
  const mine = BG.showAll ? BG.items : BG.items.filter(it => it.used);
  const q = BG.query.trim().toLowerCase();
  if (!q) return mine;
  return mine.filter(it =>
    it.title.toLowerCase().includes(q) || (it.type || '').toLowerCase().includes(q));
}

async function openBgPicker() {
  closeCtx();
  const layer = $('#bgLayer');
  layer.hidden = false;
  void layer.offsetWidth;
  layer.classList.add('show');
  BG.open = true;
  BG.query = '';
  $('#bgQuery').value = '';
  renderBgList();
  if (!BG.items.length) await loadWallpapers();
  once(() => { if (BG.open) $('#bgQuery').focus(); }, 90);
}

function closeBgPicker() {
  const layer = $('#bgLayer');
  if (!layer || layer.hidden) return;
  BG.open = false;
  layer.classList.remove('show');
  once(() => { layer.hidden = true; }, 220);
}

async function loadWallpapers() {
  const host = $('#bgList');
  host.textContent = '';
  host.appendChild(el('div', 'scan-state', '正在读取本机的 Wallpaper Engine 壁纸库…'));
  BG.loading = true;
  updateBgCount();
  try {
    const res = window.nest.listWallpapers ? await window.nest.listWallpapers() : null;
    BG.items = res && Array.isArray(res.items) ? res.items : [];
  } catch (e) {
    BG.items = [];
    toast('读取壁纸失败：' + (e && e.message ? e.message : e), 'warn');
  }
  BG.loading = false;
  if (!BG.open) return;
  renderBgList();
}

function renderBgList() {
  const host = $('#bgList');
  if (!host) return;
  host.textContent = '';
  const list = bgVisible();
  updateBgCount();
  if (!list.length) {
    host.appendChild(el('div', 'scan-state plain', BG.loading
      ? '正在读取…'
      : (BG.query ? '没有匹配的壁纸' : '没找到 Wallpaper Engine 壁纸库。点下面的「用本地图片…」直接选一张图也行')));
    return;
  }
  mountChunked(host, list.map(it => bgCard(it)), 24);
}

function bgCard(it) {
  const on = !!(S.cardBg && S.cardBg.url && it.url === S.cardBg.url);
  const node = el('button', 'bgcard' + (on ? ' on' : ''));
  node.type = 'button';
  node.title = it.title;
  const img = el('img');
  img.src = it.url;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.draggable = false;
  node.appendChild(img);
  node.appendChild(el('div', 'bgcard-name', it.title));
  node.appendChild(el('div', 'bgcard-tag', it.type ? `${it.type}${it.dynamic ? ' · 动态' : ''}` : (it.dynamic ? '动态' : '')));
  node.onclick = () => applyWallpaper(it);
  return node;
}

async function applyWallpaper(it) {
  // 视频壁纸要先抽一帧当海报、再把视频本身挂上，大概 1~2 秒
  if (it.video) toast('正在准备动态壁纸…');
  const r = await window.nest.setCardBg({ kind: 'we', file: it.image, name: it.title, video: it.video || '' });
  if (!r || !r.ok) {
    toast('这张壁纸用不了' + (r && r.error ? `（${r.error}）` : ''), 'warn');
    return;
  }
  applyCardBg(r.bg);
  renderSettingsState();
  renderBgList();
  toast(`卡片背景已换成「${it.title}」`);
}

async function pickBgImage() {
  if (!window.nest.pickBgImage) return;
  const r = await window.nest.pickBgImage();
  if (!r || !r.ok) {
    if (r && r.error) toast(r.error === 'bad-ext' ? '这个格式不支持' : r.error, 'warn');
    return;
  }
  applyCardBg(r.bg);
  renderSettingsState();
  if (BG.open) renderBgList();
  toast('卡片背景已换成自己的图片');
}

async function clearCardBg() {
  const r = window.nest.clearCardBg ? await window.nest.clearCardBg() : null;
  if (r && r.ok) applyCardBg(r.bg);
  renderSettingsState();
  if (BG.open) renderBgList();
  toast('已恢复默认背景');
}

function updateBgCount() {
  const node = $('#bgCount');
  const scope = $('#bgScope');
  const mineCount = BG.items.filter(it => it.used).length;
  if (scope) {
    scope.hidden = BG.loading || !BG.items.length;
    scope.textContent = BG.showAll ? `只看我的（${mineCount}）` : `显示全部（${BG.items.length}）`;
  }
  if (!node) return;
  node.textContent = BG.loading ? '读取中…' : `共 ${bgVisible().length} 张`;
}

async function rescan() {
  toast('正在重新扫描桌面…');
  const data = await window.nest.rescan();
  if (!data) return;
  S.items = new Map((data.items || []).map(it => [it.path, it]));
  S.pages = (data.folders || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  S.assign = data.assign || S.assign;
  S.manual = data.manual || S.manual;
  S.hidden = Array.isArray(data.hidden) ? data.hidden : S.hidden;
  S.customIcons = data.customIcons || S.customIcons;
  S.index = Math.max(0, Math.min(S.index, S.pages.length - 1));
  S.iconCount = new Set([...S.items.values()].map(i => i.icon).filter(Boolean)).size;
  renderAll();
  toast(`扫描完成：${S.items.size} 个项目 · ${S.pages.length} 页`);
}

/* ----------------------------------------------------------- 设置面板 */
function openSheet() {
  const layer = $('#sheetLayer');
  layer.hidden = false;
  renderSettingsState();
  // 桌面图标显隐可能被用户右键桌面自己改过：每次打开设置都回读一次系统真状态
  if (window.nest.desktopIconsState) {
    window.nest.desktopIconsState().then((v) => {
      if (!v || typeof v.hidden !== 'boolean' || v.hidden === S.hideIcons) return;
      S.hideIcons = v.hidden;
      S.ui.desktopIconsHidden = v.hidden;
      renderSettingsState();
    }).catch(() => {});
  }
  void layer.offsetWidth;
  layer.classList.add('show');
  // 每次打开设置都滚回顶部（上次可能划到底了）
  const body = layer.querySelector('.sheet-body');
  if (body) body.scrollTop = 0;
}
function closeSheet() {
  const layer = $('#sheetLayer');
  layer.classList.remove('show');
  once(() => { layer.hidden = true; }, 240);
}
function renderSettingsState() {
  const page = currentPage();
  $('#delHint').textContent = page ? `（${itemsOf(page).length} 个应用会一起删除）` : '';
  const hideSwitch = $('#swHideIcons');
  hideSwitch.setAttribute('aria-checked', S.hideIcons ? 'true' : 'false');
  $('#hideHint').textContent = S.hideIcons ? '当前：已隐藏' : '当前：显示中';
  $('#bgHint').textContent = '当前：' + (S.cardBg
    ? (S.cardBg.kind === 'we' ? 'Wallpaper · ' : '自定义 · ') + (S.cardBg.name || '图片')
    : '默认浅色');
  $('#swTop').setAttribute('aria-checked', S.alwaysOnTop ? 'true' : 'false');
  $('#swStartup').setAttribute('aria-checked', S.startup ? 'true' : 'false');
  applyGlassOpacity(S.glassOpacity != null ? S.glassOpacity : 80);
  applyBorderHue(S.borderHue);
  const mem = performance.memory;
  $('#statMem').textContent = mem
    ? `JS 堆 ${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB · ${S.items.size} 项 · 图标 ${S.iconCount}`
    : `${S.items.size} 项 · 图标 ${S.iconCount}`;
  $('#statPaths').textContent = S.userData || '—';
  $('#statPaths').title = S.configFile || '';
}

/* ----------------------------------------------------------- 交互绑定 */
function bindChrome() {
  $('#chipFolder').onclick = () => { /* 不再使用——永远展开模式 */ };
  $('#chip').oncontextmenu = (e) => {
    e.preventDefault();
    openCtx(e.clientX, e.clientY, [
      { label: '添加应用…', run: () => addApps() },
      { label: '从已安装软件添加…', run: () => openScan() },
      { label: '重新扫描桌面', run: () => rescan() },
      { sep: true },
      { label: S.hideIcons ? '恢复桌面图标' : '隐藏桌面图标', run: () => toggleIcons(!S.hideIcons) },
      { label: '退出 DeskNest', run: () => { persistNow(); window.nest.windowAction('close'); } }
    ]);
  };

  $('#btnEmptyAdd').onclick = () => addApps();
  $('#btnSettings').onclick = () => openSheet();
  $('#btnSheetClose').onclick = () => closeSheet();
  $('#sheetMask').onclick = () => closeSheet();

  $('#btnNewPage').onclick = () => { closeSheet(); once(() => newPage(), 180); };
  $('#btnRenamePage').onclick = () => renamePage();
  $('#btnDeletePage').onclick = () => deletePage();
  $('#btnAddApp').onclick = () => addApps();
  $('#btnAddFolder').onclick = () => addApps('folder');
  $('#btnAddWeb').onclick = () => addWeb();
  $('#btnRescan').onclick = () => rescan();
  $('#btnScanApps').onclick = () => openScan();
  $('#scanMask').onclick = () => closeScan();
  $('#scanClose').onclick = () => closeScan();
  $('#scanAll').onclick = () => toggleScanAll();
  $('#scanAdd').onclick = () => addScanned(scanVisible().filter(it => SCAN.picked.has(it.path)));
  let scanTimer = null;
  $('#scanQuery').addEventListener('input', (e) => {
    const v = e.target.value;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      SCAN.query = v;
      renderScanList();
    }, 120);
  });
  // ---- 卡片背景（Wallpaper Engine 壁纸 / 本地图片） ----
  $('#btnBgWallpaper').onclick = () => openBgPicker();
  $('#btnBgImage').onclick = () => pickBgImage();
  $('#btnBgReset').onclick = () => clearCardBg();
  $('#bgMask').onclick = () => closeBgPicker();
  $('#bgClose').onclick = () => closeBgPicker();
  $('#bgPickFile').onclick = () => pickBgImage();
  $('#bgScope').onclick = () => {
    BG.showAll = !BG.showAll;
    renderBgList();
    toast(BG.showAll ? '已显示本机全部订阅壁纸' : '只显示我自己的壁纸');
  };
  $('#bgReset').onclick = () => clearCardBg();
  let bgTimer = null;
  $('#bgQuery').addEventListener('input', (e) => {
    const v = e.target.value;
    if (bgTimer) clearTimeout(bgTimer);
    bgTimer = setTimeout(() => { bgTimer = null; BG.query = v; renderBgList(); }, 120);
  });

  $('#selRemove').onclick = () => removePicked();
  $('#selCancel').onclick = () => endSelect();

  $('#swHideIcons').onclick = () => toggleIcons(!S.hideIcons);
  $('#swTop').onclick = async () => {
    const next = !S.alwaysOnTop;
    const actual = await window.nest.setAlwaysOnTop(next);
    S.alwaysOnTop = !!(actual && actual.on !== undefined ? actual.on : next);
    S.ui.alwaysOnTop = S.alwaysOnTop;
    persist();
    renderSettingsState();
    toast(S.alwaysOnTop ? '窗口已置顶' : '已取消置顶');
  };
  $('#swStartup').onclick = async () => {
    const next = !S.startup;
    const actual = await window.nest.startup(next);
    S.startup = !!actual;
    S.ui.startup = !!actual;
    persist();
    renderSettingsState();
    toast(S.startup ? '已设为开机自启动' : '已取消开机自启动');
  };
  $('#sliderOpacity').addEventListener('input', () => {
    const v = parseInt($('#sliderOpacity').value, 10);
    S.glassOpacity = v;
    S.ui.glassOpacity = v;
    applyGlassOpacity(v);
    persist();
  });
  $('#sliderBorderWidth').addEventListener('input', () => {
    const v = parseFloat($('#sliderBorderWidth').value) || 0;
    S.borderWidth = v;
    S.ui.borderWidth = v;
    applyBorderWidth(v);
    persist();
  });
  $('#sliderBorder').addEventListener('input', () => {
    const v = parseInt($('#sliderBorder').value, 10) || 0;
    S.borderHue = v;
    S.ui.borderHue = v;
    applyBorderHue(v);
    persist();
  });
  $('#sliderText').addEventListener('input', () => {
    const v = parseInt($('#sliderText').value, 10) || 0;
    S.textHue = v;
    S.ui.textHue = v;
    applyTextHue(v);
    persist();
  });
  window.addEventListener('pointerup', () => { if (document.body.classList.contains('morphing')) endMorph(); });

  $('#btnQuit').onclick = async () => {
    const ok = await dialog({ title: '退出 DeskNest', body: '退出后桌面收纳界面会关闭，桌面图标不受影响。', ok: '退出', danger: true });
    if (!ok) return;
    persistNow();
    window.nest.windowAction('close');
  };

  $('#navPrev').onclick = () => goPage(S.index - 1);
  $('#navNext').onclick = () => goPage(S.index + 1);

  // ---- 窗口缩放把手（拖拽四边四角） ----
  let resizeState = null;
  document.querySelectorAll('.rh').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      resizeState = { edge: el.dataset.edge, sx: e.screenX, sy: e.screenY };
      markMorphing(400);
    });
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizeState) return;
    // 鼠标在窗口外松开时收不到 mouseup，这里用按键状态兜底
    if (!(e.buttons & 1)) { resizeState = null; document.body.classList.remove('morphing'); return; }
    const dx = e.screenX - resizeState.sx, dy = e.screenY - resizeState.sy;
    if (!dx && !dy) return;
    window.nest.resize(resizeState.edge, dx, dy);
    resizeState.sx = e.screenX; resizeState.sy = e.screenY;
    markMorphing(400);
  });
  document.addEventListener('mouseup', () => {
    if (!resizeState) return;
    resizeState = null;
    markMorphing(200);
  });

  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    const v = e.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      S.query = v;
      renderMain();
    }, 110);
  });

  /* 鼠标横向拖拽翻页（手机的划页手感） */
  const stage = $('#stage');
  let swipe = null;
  stage.addEventListener('pointerdown', (e) => {
    if (S.query.trim()) return;
    if (e.target.closest('.item')) return;
    swipe = { x: e.clientX, moved: 0 };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!swipe) return;
    swipe.moved = e.clientX - swipe.x;
    if (Math.abs(swipe.moved) > 6) {
      const pct = (swipe.moved / stage.clientWidth) * 38;
      $('#pages').style.transform = `translateX(calc(${-S.index * 100}% + ${pct}px))`;
    }
  });
  const endSwipe = () => {
    if (!swipe) return;
    const moved = swipe.moved;
    swipe = null;
    $('#pages').style.transition = '';
    if (moved < -70) goPage(S.index + 1);
    else if (moved > 70) goPage(S.index - 1);
    else goPage(S.index);          // 回弹
  };
  stage.addEventListener('pointerup', endSwipe);
  stage.addEventListener('pointercancel', endSwipe);
  stage.addEventListener('pointerleave', endSwipe);

  /* 空白处右键 = 页面菜单 */
  stage.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.item')) return;
    e.preventDefault();
    const page = currentPage();
    openCtx(e.clientX, e.clientY, [
      { head: page ? `页面「${page.name}」` : '页面' },
      { label: '新建页面…', run: () => newPage() },
      { label: '重命名当前页…', run: () => renamePage() },
      { sep: true },
      { label: '添加应用…', run: () => addApps() },
      { label: '从已安装软件添加…', run: () => openScan() },
      { label: '添加文件夹…', run: () => addApps('folder') },
      { label: '设置', run: () => openSheet() }
    ]);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.ctx')) closeCtx();
  });
  window.addEventListener('blur', () => closeCtx());

  /* 外部文件 / 文件夹直接拖进卡片 = 添加到当前页 */
  document.addEventListener('dragover', (e) => {
    if (S.drag) return;                                   // 内部拖动由磁贴自己处理
    const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
    if (!types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', async (e) => {
    if (S.drag) return;
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    e.preventDefault();
    const paths = [];
    for (const f of files) {
      const p = window.nest.pathForFile ? window.nest.pathForFile(f) : '';
      if (p) paths.push(p);
    }
    if (!paths.length) return;
    const picked = await window.nest.addPaths(paths);
    if (!picked || !picked.length) return;
    await ingestItems(picked);
    toast(`已添加 ${picked.length} 项`);
  });

  document.addEventListener('keydown', (e) => {
    const inField = e.target instanceof HTMLInputElement;
    if (e.key === 'Escape') {
      if (S.selecting) return endSelect();
      if (!$('#ctx').hidden) return closeCtx();
      if (BG.open) return closeBgPicker();
      if (SCAN.open) return closeScan();
      if (!$('#sheetLayer').hidden) return closeSheet();
      if (S.query) { $('#search').value = ''; S.query = ''; return renderMain(); }
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (S.collapsed) expand();
      once(() => $('#search').focus(), 260);
      return;
    }
    if (inField) return;
    if (e.key === 'ArrowRight') goPage(S.index + 1);
    if (e.key === 'ArrowLeft') goPage(S.index - 1);
  });

  window.addEventListener('resize', () => {
    const page = currentPage();
    if (!page) return;
    $('#pageMeta').textContent = `${itemsOf(page).length} 个应用`;
  });

  // 置顶可能在主进程那边被改（托盘菜单勾选），渲染层的 S.alwaysOnTop 若一直抱着旧值，
  // 设置面板就会显示错误状态，下次 persist 还会把旧值带回去。这里一律以窗口真实状态为准。
  const syncTop = (st) => {
    if (!st || typeof st.alwaysOnTop !== 'boolean') return;
    if (st.alwaysOnTop === S.alwaysOnTop) return;
    S.alwaysOnTop = st.alwaysOnTop;
    if (S.ui) S.ui.alwaysOnTop = st.alwaysOnTop;
    renderSettingsState();
  };
  window.nest.onWinState((st) => { syncTop(st); setPaused(!st || !st.visible || st.minimized); });
  window.nest.winState().then((st) => { if (st) { syncTop(st); setPaused(!st.visible || st.minimized); } });
}

async function toggleIcons(target) {
  const r = await window.nest.toggleDesktopIcons(target);
  const hidden = r && typeof r.hidden === 'boolean' ? r.hidden : target;
  S.hideIcons = hidden;
  S.ui.desktopIconsHidden = hidden;
  persist();
  renderSettingsState();
  toast(hidden ? '桌面图标已隐藏（随时可恢复）' : '桌面图标已恢复');
}

function setPaused(flag) {
  document.getElementById('app').classList.toggle('paused', !!flag);
  syncCardVideo();
  const layer = $('#sheetLayer');
  if (flag) {
    if (morphTimer) { clearTimeout(morphTimer); morphTimer = null; }
    document.body.classList.remove('morphing');
    clearTimers(); closeCtx();
    // 窗口马上要被隐藏：立刻把设置层收干净，不能等 closeSheet 那个 240ms 定时器。
    // 窗口隐藏后渲染进程会被节流/冻结，定时器可能迟迟不跑；用户很快再打开时，
    // 这层 opacity:0 的全屏遮罩还留在原地，会把所有点击静默吃掉 →「卡片卡住没反应」。
    if (layer) { layer.classList.remove('show'); layer.hidden = true; }
    // 扫描层同样是全屏遮罩，跟着一起收干净（理由同上）
    const scan = $('#scanLayer');
    if (scan) { SCAN.open = false; scan.classList.remove('show'); scan.hidden = true; }
    // 壁纸选择层也是全屏遮罩，同样立刻收干净
    const bg = $('#bgLayer');
    if (bg) { BG.open = false; bg.classList.remove('show'); bg.hidden = true; }
  } else if (layer && !layer.classList.contains('show')) {
    // 重新显示：只要设置层不在展开状态，就确保它彻底 hidden，避免残留遮罩
    layer.hidden = true;
    const scan = $('#scanLayer');
    if (scan && !SCAN.open) scan.hidden = true;
    const bg = $('#bgLayer');
    if (bg && !BG.open) bg.hidden = true;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  // 窗口重新可见时主动回读一次窗口状态：即使 show 事件里的那条状态消息丢了，
  // 也能把 paused 复位，避免"再打开卡片后卡住没反应"。
  document.addEventListener('visibilitychange', () => {
    applyAsleep();
    if (document.hidden || !window.nest.winState) return;
    window.nest.winState().then((st) => { if (st) setPaused(!st.visible || st.minimized); }).catch(() => {});
  });
  // 点击兜底：窗口若处于"未激活"状态，第一下点击可能只激活窗口、不落到控件上；
  // 这里显式把焦点要回来，保证点图标就是点图标，而不是被吞掉。
  document.addEventListener('pointerdown', () => {
    if (!document.hasFocus() && window.nest.focus) window.nest.focus().catch(() => {});
  }, true);
  // 冷启动预热：主进程把窗口临时挪到屏幕外撑成展开尺寸，我们先摆出展开态把面板/图标首帧栅格化掉，
  // 这样用户第一次点开时不会卡那一下（测出来是 99ms 掉 5 帧）。预热完立刻收回，用户全程看不到。
  if (window.nest.onPrewarm) {
    window.nest.onPrewarm((on) => {
      document.body.classList.toggle('expanded', !!on);
      document.body.classList.toggle('collapsed', !on);
    });
  }
  // 原生 Acrylic 激活：系统接管毛玻璃，截图模糊层 + 白色玻璃覆盖全关掉
  if (window.nest.onAcrylic) {
    window.nest.onAcrylic((on) => {
      document.body.classList.toggle('has-acrylic', !!on);
    });
  }
  // 磨砂白底图：主进程的常驻抓屏流每 250ms 送来一帧「卡片正下方那块屏幕」（JPEG，160×104）。
  // 这里只负责把它塞进 --backdrop；糊化 / 去色 / 压白全部交给 CSS —— 底图只贡献明暗，
  // 不贡献颜色，所以背后是什么颜色的窗口都不会把卡片染色。
  if (window.nest.onBackdropFrame) {
    window.nest.onBackdropFrame((b64) => {
      if (!b64) return;
      document.documentElement.style.setProperty('--backdrop', 'url("data:image/jpeg;base64,' + b64 + '")');
      document.body.classList.add('has-backdrop');
    });
  }
  bindChrome();
  boot();
});