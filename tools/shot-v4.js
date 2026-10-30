'use strict';
/**
 * DeskNest v3 visual/interaction regression (white frosted glass + paged launcher).
 * NOTE: this test NEVER raises / focuses the window: the user is looking at the screen.
 * Cost of that: an occluded window gets its setTimeout throttled by Chromium, so the
 * waits below are deliberately seconds long.
 *   node tools/shot-v4.js [port]
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
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`artifacts/${name}`, Buffer.from(s.data, 'base64'));
  };
  const ok = (label, cond, detail) => console.log((cond ? 'PASS ' : 'FAIL ') + label + '  ' + JSON.stringify(detail));

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2000);

  // ---- 1. collapsed = white circular button with an upward arrow
  const chip = await ev(`(()=>{const c=document.getElementById('chip');
    return {chipVisible:!c.hidden, mainHidden:document.getElementById('main').hidden,
      roundBtn:!!document.querySelector('.chip-btn'), arrow:document.querySelectorAll('.chip-btn svg path').length,
      buttonRound:(()=>{const b=document.querySelector('.chip-btn'); return b?getComputedStyle(b).borderRadius:'-';})(),
      collapsedClass:document.body.classList.contains('collapsed'),
      appRadius:getComputedStyle(document.getElementById('app')).borderRadius,
      win:[window.innerWidth,window.innerHeight]};})()`);
  ok('收起态 = 白色圆形按钮 + 向上箭头',
    chip.chipVisible && chip.mainHidden && chip.roundBtn && chip.arrow === 2 && chip.collapsedClass &&
    chip.buttonRound === '50%' && chip.win[0] < 220, chip);
  await shot('v4-chip.png');

  // ---- 2. expand -> paged main UI
  await ev(`document.getElementById('chipFolder').click(); true`);
  await sleep(5000);
  // 页码落在第 1 页，断言才可复现（上一次运行可能停在第 N 页）
  await ev(`(()=>{const d=document.querySelectorAll('#dots .dot')[0]; if(d) d.click(); return true;})()`);
  await sleep(1200);
  const main = await ev(`(()=>({mainVisible:!document.getElementById('main').hidden, chipHidden:document.getElementById('chip').hidden,
    pages:document.querySelectorAll('#pages .page').length, tiles:document.querySelectorAll('#pages .item').length,
    dots:document.querySelectorAll('#dots .dot').length, activeDot:document.querySelectorAll('#dots .dot.on').length,
    arrows:[!document.getElementById('navPrev').classList.contains('off'),!document.getElementById('navNext').classList.contains('off')],
    name:document.getElementById('pageName').value, meta:document.getElementById('pageMeta').textContent,
    collapsedClass:document.body.classList.contains('collapsed'),
    win:[window.innerWidth,window.innerHeight],
    broken:[...document.querySelectorAll('#pages .item img')].filter(i=>{const r=i.getBoundingClientRect(); return r.width>0 && r.left>-100 && r.left<window.innerWidth+100 && i.naturalWidth===0;}).length}))()`);
  ok('展开态 = 分页主界面', main.mainVisible && main.chipHidden && main.pages > 1 && main.tiles > 0 &&
    main.arrows[1] && !main.collapsedClass && main.win[0] > 700, main);
  await shot('v4-main.png');

  // ---- 3. side arrow pages forward
  const before = await ev(`document.getElementById('pages').style.transform`);
  await ev(`document.getElementById('navNext').click(); true`);
  await sleep(900);
  const after = await ev(`(()=>({t:document.getElementById('pages').style.transform, name:document.getElementById('pageName').value,
    dots:document.querySelectorAll('#dots .dot.on')[0]?.title}))()`);
  ok('侧边右箭头翻到下一页', before !== after.t && after.dots, { before, after });
  const p2 = await ev(`(()=>({tiles:document.querySelectorAll('#pages .page')[1].querySelectorAll('.item').length, name:document.getElementById('pageName').value}))()`);
  await shot('v4-page2.png');
  console.log('  第一页:', JSON.stringify({ name: main.name, meta: main.meta }), ' 第二页:', JSON.stringify(p2));

  // ---- 4. settings gear sheet
  await ev(`document.getElementById('btnSettings').click(); true`);
  await sleep(1500);
  const sheet = await ev(`(()=>({shown:document.getElementById('sheetLayer').classList.contains('show'),
    rows:document.querySelectorAll('#sheet .row').length, swatches:document.querySelectorAll('#swatches .swatch').length,
    hideHint:document.getElementById('hideHint').textContent, stat:document.getElementById('statMem').textContent}))()`);
  ok('设置齿轮抽屉', sheet.shown && sheet.rows >= 10 && sheet.swatches === 8, sheet);
  await shot('v4-settings.png');

  // ---- 5. search
  await ev(`document.getElementById('btnSheetClose').click(); true`);
  await sleep(400);
  await ev(`(()=>{const s=document.getElementById('search');s.value='微';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(2600);
  const search = await ev(`(()=>({title:document.getElementById('pageName').value, hits:document.querySelectorAll('#pages .item').length,
    broken:[...document.querySelectorAll('#pages .item img')].filter(i=>i.naturalWidth===0).length, q:S.query}))()`);
  ok('搜索过滤', search.title === '搜索结果' && search.hits > 0 && search.broken === 0, search);
  await shot('v4-search.png');
  await ev(`(()=>{const s=document.getElementById('search');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(2600);

  // ---- 6. collapse back to the round button
  await ev(`document.getElementById('btnCollapse').click(); true`);
  await sleep(1600);
  const back = await ev(`(()=>({chip:!document.getElementById('chip').hidden, main:document.getElementById('main').hidden,
    collapsedClass:document.body.classList.contains('collapsed'), win:[window.innerWidth,window.innerHeight]}))()`);
  ok('收起回桌面圆钮', back.chip && back.main && back.collapsedClass && back.win[0] < 220, back);

  // ---- 7. safety: never leave the user's desktop icons hidden because of a test run
  const icons = await ev(`window.nest.desktopIconsState()`);
  ok('测试没有改动桌面图标显隐', icons && icons.hidden === false, icons);

  console.log('saved: v4-chip / v4-main / v4-page2 / v4-settings / v4-search');
  ws.close();
  process.exit(0);
})().catch(e => { console.error('shot-v4 失败：', e.message); process.exit(1); });