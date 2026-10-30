'use strict';
/**
 * 视觉回归截图脚本：连到已开 --remote-debugging-port 的 DeskNest，
 * 断言关键布局/图标/显隐，并导出主视图、文件夹面板、搜索三张截图。
 *   node tools/shot.js [port]
 */
const fs = require('node:fs');

const PORT = Number(process.argv[2] || 9222);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  await new Promise(r => { ws.onopen = r; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(3400);

  const ok = (name, cond, detail) => console.log((cond ? 'PASS ' : 'FAIL ') + name + '  ' + JSON.stringify(detail));

  const geo = await ev(`(()=>{const cards=[...document.querySelectorAll('.folder-card')];
    const r=cards.map(c=>{const b=c.getBoundingClientRect();return [Math.round(b.x),Math.round(b.y),Math.round(b.width),Math.round(b.height)];});
    const sq=document.querySelector('.squircle').getBoundingClientRect();
    const st=document.getElementById('stage');
    const sw=document.querySelector('.search-wrap').getBoundingClientRect();
    const app=document.getElementById('app').getBoundingClientRect();
    return {n:cards.length,rows:[...new Set(r.map(x=>x[1]))].length,first:r[0],
      squircle:[Math.round(sq.width),Math.round(sq.height)],
      vOverflow:st.scrollHeight-st.clientHeight,hOverflow:st.scrollWidth-st.clientWidth,
      searchOffset:[Math.round(sw.left-app.left),Math.round(sw.width)],
      title:document.querySelector('.section-title')?.textContent};})()`);
  ok('主视图卡片/行数/无溢出', geo.n === 10 && geo.rows === 2 && geo.vOverflow === 0 && geo.hOverflow === 0, geo);

  ok('移动条默认隐藏（[hidden] 生效）', await ev('getComputedStyle(document.getElementById("moveBar")).display') === 'none');

  await ev(`document.getElementById('toasts').textContent=''`);
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 30, g: 38, b: 66, a: 1 } });
  let s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('artifacts/v3-main.png', Buffer.from(s.data, 'base64'));

  await ev('document.querySelector(".folder-card").click(); true');
  await sleep(1100);
  const panel = await ev(`(()=>{const g=document.getElementById('panelGrid');const it=[...g.querySelectorAll('.item')];
    const imgs=[...g.querySelectorAll('.item .tile img')];
    const broken=imgs.filter(i=>i.naturalWidth===0);
    const tiles=it.map(n=>{const b=n.getBoundingClientRect();return [Math.round(b.width),Math.round(b.height)];});
    return {items:it.length,cols:new Set(it.map(n=>Math.round(n.getBoundingClientRect().x))).size,
      firstTile:tiles[0],imgs:imgs.length,broken:broken.length};})()`);
  ok('面板为网格且图标全部加载', panel.cols >= 2 && panel.broken === 0 && panel.imgs > 0, panel);

  s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('artifacts/v3-folder.png', Buffer.from(s.data, 'base64'));

  await ev('document.getElementById("panelBack").click(); true');
  await sleep(400);
  await ev(`(async()=>{const s=document.getElementById("search"); s.value="微信"; s.dispatchEvent(new Event("input",{bubbles:true})); await new Promise(r=>setTimeout(r,420));})()`);
  s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('artifacts/v3-search.png', Buffer.from(s.data, 'base64'));
  const sr = await ev(`(()=>({hits:document.querySelectorAll('.grid-items .item').length,broken:[...document.querySelectorAll('.grid-items .item .tile img')].filter(i=>i.naturalWidth===0).length}))()`);
  ok('搜索结果图标正常', sr.broken === 0, sr);
  await ev(`(async()=>{const s=document.getElementById("search"); s.value=""; s.dispatchEvent(new Event("input",{bubbles:true}));})()`);

  console.log('saved: artifacts/v3-main.png, v3-folder.png, v3-search.png');
  ws.close();
  process.exit(0);
})().catch(e => { console.error('shot.js 失败：', e.message); process.exit(1); });