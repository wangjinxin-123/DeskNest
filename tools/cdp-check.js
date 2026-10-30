'use strict';
/**
 * 无依赖 CDP 自检脚本：连到已开启 --remote-debugging-port 的 DeskNest，
 * 断言关键 UI 与真实图标，并导出截图。用法：
 *   node tools/cdp-check.js [port]
 */
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.argv[2] || 9222);
const OUT = path.join(__dirname, '..', 'artifacts');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error('CDP: 未找到页面目标');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close: () => ws.close()
    });
    ws.onerror = (e) => reject(new Error('WS error: ' + (e && e.message)));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
        else p.res(msg.result);
      }
    };
  });
}

(async () => {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) throw new Error('EVAL: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };

  await sleep(1500);                       // 等首次扫描 + 首帧渲染

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS ' : 'FAIL ') + name + '  ' + (detail == null ? '' : JSON.stringify(detail)));
  };

  check('preload API 白名单', await evaluate('Object.keys(window.nest).sort().join(",")') === [
    'addExtras', 'desktopIconsState', 'init', 'launch', 'onWinState', 'openPath', 'pickApps',
    'rescan', 'reveal', 'saveConfig', 'setAlwaysOnTop', 'toggleDesktopIcons', 'winState', 'windowAction'
  ].sort().join(','), await evaluate('Object.keys(window.nest).length'));

  const folderCount = await evaluate('document.querySelectorAll(".folder-card").length');
  check('文件夹卡片渲染', folderCount > 0, folderCount);

  const firstNames = await evaluate('[...document.querySelectorAll(".folder-name")].map(n=>n.textContent).join("|")');
  check('前两个文件夹为 编程开发 / 桌面文件夹',
    firstNames.split('|')[0] === '编程开发' && firstNames.split('|')[1] === '桌面文件夹', firstNames);

  const gridImgs = await evaluate('document.querySelectorAll(".squircle .mini-ico img").length');
  check('九宫格内真实图标(>0)', gridImgs > 0, gridImgs);

  const realIcon = await evaluate('(document.querySelector(".squircle .mini-ico img")||{}).getAttribute?.("src")?.slice(0,20)');
  check('图标走真实系统图标协议', String(realIcon).startsWith('nest-icon://'),
    await evaluate(`(()=>{const imgs=[...document.querySelectorAll('.squircle .mini-ico img,.item .tile img')];
      return {src:imgs[0]?.getAttribute('src'),loaded:imgs.filter(i=>i.naturalWidth>0).length,total:imgs.length};})()`));

  // 打开第一个文件夹 → 面板
  await evaluate('document.querySelector(".folder-card").click(); true');
  await sleep(500);
  const panelOpen = await evaluate('(()=>{const l=document.getElementById("panelLayer"); return !l.hidden && l.classList.contains("show");})()');
  check('点击文件夹打开面板', panelOpen === true, panelOpen);
  const panelItems = await evaluate('document.querySelectorAll("#panelGrid .item").length');
  check('面板铺开网格', panelItems > 0, panelItems);
  const panelName = await evaluate('document.getElementById("panelName").value');
  check('面板标题=文件夹名', panelName === '编程开发', panelName);

  // 拖拽接口存在性（移动条）
  await evaluate('window.__dragTest = (()=>{const it=document.querySelector("#panelGrid .item"); if(!it) return "no-item"; const dt=new DataTransfer(); const ev=new DragEvent("dragstart",{bubbles:true,dataTransfer:dt}); it.dispatchEvent(ev); const bar=document.getElementById("moveBar"); return bar.hidden ? "bar-hidden" : "bar-shown";})()');
  const dragRes = await evaluate('window.__dragTest');
  check('拖拽时出现移动目标条', dragRes === 'bar-shown', dragRes);

  // 返回
  await evaluate('document.getElementById("panelBack").click(); true');
  await sleep(400);
  const panelClosed = await evaluate('document.getElementById("panelLayer").hidden');
  check('返回后面板收起', panelClosed === true, panelClosed);

  // 搜索过滤
  const searchRes = await evaluate(`(async()=>{
    const s=document.getElementById('search');
    s.value='微信'; s.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,320));
    const hits=document.querySelectorAll('.grid-items .item').length;
    const title=document.querySelector('.section-title')?.textContent||'';
    s.value=''; s.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,320));
    return {hits,title};
  })()`);
  check('搜索实时筛选并显示结果区', /搜索结果/.test(searchRes.title), searchRes);

  // 统计栏
  const stats = await evaluate('document.getElementById("statItems").textContent + " / " + document.getElementById("statFolders").textContent + " / " + document.getElementById("statHeap").textContent');
  check('状态栏统计输出', /\d+ 个项目/.test(stats), stats);

  // 隐藏 / 恢复桌面图标（真实改注册表 + WM_COMMAND）
  const hideRes = await evaluate('(async()=>{const r=await window.nest.toggleDesktopIcons(true); const st=await window.nest.desktopIconsState(); return {r,hidden:st.hidden};})()');
  check('隐藏桌面图标生效', hideRes.hidden === true, hideRes);
  const showRes = await evaluate('(async()=>{const r=await window.nest.toggleDesktopIcons(false); const st=await window.nest.desktopIconsState(); return {r,hidden:st.hidden};})()');
  check('恢复桌面图标生效', showRes.hidden === false, showRes);

  // 置顶开关
  const topRes = await evaluate('(async()=>{const a=await window.nest.setAlwaysOnTop(true); const b=await window.nest.setAlwaysOnTop(false); return [a,b];})()');
  check('窗口置顶可切换', topRes[0] === true && topRes[1] === false, topRes);

  // 配置持久化文件
  await evaluate('window.nest.saveConfig({folders:undefined})');
  const paths = await evaluate('(async()=>{const s=await window.nest.init(); return [s.configFile, s.iconCacheFile, s.items.length];})()');
  check('配置/缓存路径来自 userData', /desknest-config\.json$/.test(paths[0]) && /desknest-icon-cache\.json$/.test(paths[1]), paths);

  await evaluate(`(async()=>{const s=document.getElementById('search'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(600);

  // 截图（补一个桌面化底色，便于预览透明窗口）
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 18, g: 26, b: 48, a: 1 }
  });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'desknest-main.png'), Buffer.from(shot.data, 'base64'));

  await evaluate('document.querySelector(".folder-card").click(); true');
  await sleep(600);
  // 面板截图时把窗口底色还原成透明
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'desknest-folder.png'), Buffer.from(shot2.data, 'base64'));

  const failed = results.filter(r => !r.ok);
  console.log(`\n总结：${results.length - failed.length}/${results.length} 通过`);
  console.log('截图：artifacts/desknest-main.png, artifacts/desknest-folder.png');
  cdp.close();
  process.exit(failed.length ? 2 : 0);
})().catch(e => { console.error('自检异常：', e.message); process.exit(1); });