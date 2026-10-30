'use strict';
/**
 * 毛玻璃探针：把玻璃提亮层压到几乎透明，输出窗口在屏幕上的真实位置，
 * 便于用系统级截图判断"系统 acrylic 虚化到底有没有生效"。
 *   node tools/glass-probe.js [opacity]   # 默认 0.10
 */
(async () => {
  const alpha = Number(process.argv[2] || 0.10);
  const l = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const p = l.find(t => t.type === 'page');
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let i = 0; const q = new Map();
  await new Promise(r => { ws.onopen = r; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m.result); q.delete(m.id); } };
  const send = (me, pa = {}) => new Promise(r => { const id = ++i; q.set(id, r); ws.send(JSON.stringify({ id, method: me, params: pa })); });
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.value;

  await ev(`(()=>{const g=document.querySelector('.glass');
    g.style.background='rgba(255,255,255,${alpha})'; g.style.boxShadow='none';
    document.querySelector('.app').style.background='transparent'; return true;})()`);
  const geo = await ev(`(()=>({x:window.screenX,y:window.screenY,w:window.outerWidth,h:window.outerHeight,dpr:window.devicePixelRatio}))()`);
  console.log(JSON.stringify(geo));
  ws.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });