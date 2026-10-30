'use strict';
/**
 * 把窗口临时提到最前（真桌面截图用）+ 打印它在屏幕上的真实位置。
 *   node tools/front-probe.mjs top|down
 */
const mode = process.argv[2] || 'top';
const l = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const p = l.find(t => t.type === 'page');
const ws = new WebSocket(p.webSocketDebuggerUrl);
let i = 0; const q = new Map();
await new Promise(r => { ws.onopen = r; });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m.result); q.delete(m.id); } };
const send = (me, pa = {}) => new Promise(r => { const id = ++i; q.set(id, r); ws.send(JSON.stringify({ id, method: me, params: pa })); });
const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.value;
const geo = () => ev(`({x:screenX,y:screenY,w:outerWidth,h:outerHeight,vis:document.visibilityState,chip:!document.getElementById('chip').hidden,page:document.getElementById('pageName').value})`);
if (mode === 'raise') {
  // 把窗口真正提到最前：hide + show（最大化 IDE 盖住桌面时，仅 setAlwaysOnTop 不够）
  await ev(`window.nest.setAlwaysOnTop(true)`);
  await ev(`window.nest.windowAction('hide')`);
  await new Promise(r => setTimeout(r, 400));
  await ev(`window.nest.windowAction('toggle')`);
  await new Promise(r => setTimeout(r, 900));
} else if (mode === 'top' || mode === 'expand') {
  await ev(`window.nest.setAlwaysOnTop(true)`);
  if (mode === 'expand') await ev(`(async()=>{ if(!document.getElementById('chip').hidden) document.getElementById('chipFolder').click(); })()`);
  await new Promise(r => setTimeout(r, 900));
} else {
  if (mode === 'collapse') await ev(`(async()=>{ if(document.getElementById('chip').hidden) document.getElementById('btnCollapse').click(); })()`);
  await ev(`window.nest.setAlwaysOnTop(false)`);
  await new Promise(r => setTimeout(r, 700));
}
console.log(JSON.stringify(await geo()));
ws.close();
process.exit(0);