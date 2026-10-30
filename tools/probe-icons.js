'use strict';
/* 探查：桌面项目的图标是否真的各不相同（判断 getFileIcon 是否解析了快捷方式目标） */
(async () => {
  const l = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const p = l.find(t => t.type === 'page');
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  let i = 0; const q = new Map();
  await new Promise(r => { ws.onopen = r; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m.result); q.delete(m.id); } };
  const send = (me, pa = {}) => new Promise(r => { const id = ++i; q.set(id, r); ws.send(JSON.stringify({ id, method: me, params: pa })); });
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.value;

  const expr = `(async()=>{
    const s = await window.nest.init();
    const groups = {};
    for (const it of s.items) {
      const head = it.icon ? it.icon.slice(30, 80) : 'NO_ICON';
      const k = it.type + '|' + head;
      (groups[k] = groups[k] || []).push(it.name);
    }
    return { total: s.items.length,
      groups: Object.entries(groups).map(([k, v]) => ({ fp: k.slice(0, 46), n: v.length, sample: v.slice(0, 3) })) };
  })()`;

  const out = await ev(expr);
  console.log('total items:', out.total);
  for (const g of out.groups) console.log(String(g.n).padStart(3), g.fp, JSON.stringify(g.sample));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });