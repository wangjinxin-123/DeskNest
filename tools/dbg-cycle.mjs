const l = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const p = l.find(t => t.type === 'page');
const ws = new WebSocket(p.webSocketDebuggerUrl);
let i=0; const q=new Map();
await new Promise(r=>{ws.onopen=r;});
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&q.has(m.id)){q.get(m.id)(m.result);q.delete(m.id);}};
const send=(me,pa={})=>new Promise(r=>{const id=++i;q.set(id,r);ws.send(JSON.stringify({id,method:me,params:pa}));});
const ev=async x=>(await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true})).result.value;
const geo=()=>ev(`({x:screenX,y:screenY,w:outerWidth,h:outerHeight})`);
const st=()=>ev(`window.nest.winState()`);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
console.log('start  ', JSON.stringify(await geo()), JSON.stringify(await st()));
for (const step of ['expand','collapse','expand','collapse','expand','collapse']) {
  await ev(step==='expand' ? `window.nest.setCollapsed(false)` : `window.nest.setCollapsed(true)`);
  await sleep(900);
  console.log(step.padEnd(8), JSON.stringify(await geo()), JSON.stringify(await st()));
}
ws.close(); process.exit(0);
