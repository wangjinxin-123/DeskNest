'use strict';
/**
 * 校验：卸载后的遗留项是否彻底消失 + 自身快捷方式是否已被收纳
 *   node tools/verify-clean.js
 */
(async () => {
  const l = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const p = l.find(t => t.type === 'page');
  if (!p) throw new Error('打开带 --remote-debugging-port=9222 的实例后再跑');
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let i = 0; const q = new Map();
  await new Promise(r => { ws.onopen = r; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m.result); q.delete(m.id); } };
  const send = (me, pa = {}) => new Promise(r => { const id = ++i; q.set(id, r); ws.send(JSON.stringify({ id, method: me, params: pa })); });
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.value;

  const r = await ev(`(async()=>{
    const s = await window.nest.init();
    const names = s.items.map(x => x.name);
    return {
      total: names.length,
      folders: s.folders.length,
      legacy_left: names.filter(n => /rainmeter|nexus|winstep/i.test(n)),
      own_shortcut: names.filter(n => /desknest/i.test(n)),
      history_left: (s.folders || []).flatMap(f => f.items || []).filter(n => /rainmeter|nexus|winstep/i.test(typeof n === 'string' ? n : (n.name || ''))).length
    };
  })()`);
  console.log('items       =', r.total);
  console.log('folders     =', r.folders);
  console.log('legacy_left =', JSON.stringify(r.legacy_left));
  console.log('own_shortcut=', JSON.stringify(r.own_shortcut));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });