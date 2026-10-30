'use strict';
/**
 * 真·鼠标点击回归（不是 DOM .click()）：走 CDP Input 注入，会经过浏览器进程的命中测试，
 * 因此能抓到"-webkit-app-region: drag 把按钮点击吃掉"这类问题。
 *   node tools/click-test.js [port]
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const PORT = Number(process.argv[2] || 9222);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  await new Promise(r => { ws.onopen = r; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };
  const ok = (label, cond, detail) => console.log((cond ? 'PASS ' : 'FAIL ') + label + '  ' + JSON.stringify(detail));
  const realClick = async (sel) => {
    const box = await ev(`(()=>{const e=document.querySelector('${sel}');const r=e.getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height};})()`);
    const args = { x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...args });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...args });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...args });
    return box;
  };
  const state = () => ev(`({chip:!document.getElementById('chip').hidden, main:!document.getElementById('main').hidden,
    collapsed:document.body.classList.contains('collapsed'), w:window.innerWidth, h:window.innerHeight})`);

  await send('Runtime.enable');
  await sleep(1200);

  // 先确保是展开态：用渲染层自己的入口（DOM click，只做状态准备）
  if (await ev(`!document.getElementById('chip').hidden`)) {
    await ev(`document.getElementById('chipFolder').click()`);
  }
  await sleep(2500);
  const s0 = await state();
  const info = await ev(`(()=>{const b=document.getElementById('btnCollapse');const r=b.getBoundingClientRect();
    const foot=b.closest('.foot')!==null; const bar=b.closest('.bar')!==null;
    const region=getComputedStyle(b).getPropertyValue('-webkit-app-region')||'(none)';
    return {inFoot:foot,inBar:bar,region,dx:Math.abs((r.left+r.width/2)-window.innerWidth/2),bottom:Math.round(window.innerHeight-r.bottom),size:Math.round(r.width)};})()`);
  ok('收起按钮位置=面板底部正中 + 不在拖动区', s0.main && info.inFoot && !info.inBar && info.dx <= 2 && info.region === 'no-drag' && info.size >= 26, { ...info, s0 });

  // 真鼠标点击收起
  const box1 = await realClick('#btnCollapse');
  await sleep(2500);
  const s1 = await state();
  ok('真鼠标点收起 → 变成桌面圆钮', s1.chip && !s1.main && s1.collapsed && s1.w < 220, { box1, s1 });

  // 真鼠标点击圆钮展开
  const box2 = await realClick('.chip-btn');
  await sleep(3000);
  const s2 = await state();
  ok('真鼠标点圆钮 → 展开主界面', !s2.chip && s2.main && !s2.collapsed && s2.w > 700, { box2, s2 });

  // 拖动区仍然要能动窗口：点标题栏空白处不应该触发任何按钮行为
  await realClick('.bar');
  await sleep(800);
  const s3 = await state();
  ok('点拖动区空白 = 什么都没发生', s3.main && !s3.chip, s3);

  ws.close();
  process.exit(0);
})().catch(e => { console.error('click-test 失败：', e.message); process.exit(1); });