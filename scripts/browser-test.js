import {chromium,firefox} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createApp} from '../server/index.js';
// Deterministic player double. Real VK verification is a separate test:vk run.
const mock=`window.VK={VideoPlayer:function(){let position=0,playing=false,updated=Date.now(),listeners={};const emit=e=>setTimeout(()=>{(listeners[e]||[]).forEach(f=>f({state:playing?'playing':'paused'}))},30);const time=()=>position+(playing?(Date.now()-updated)/1000:0);const api={play(){position=time();updated=Date.now();playing=true;emit('started')},pause(){position=time();updated=Date.now();playing=false;emit('paused')},seek(t){position=t;updated=Date.now();emit('seeked')},getCurrentTime:time,getState:()=>playing?'playing':'paused',getDuration:()=>3600,getErrorCode:()=>0,on(e,f){(listeners[e]||(listeners[e]=[])).push(f)},destroy(){listeners={}}};window.testPlayer=api;setTimeout(()=>emit('inited'),50);return api;}};`;
await mkdir('test-results',{recursive:true});
const app=await createApp({dataDir:null,grace:1000});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${app.server.address().port}`,results=[];
try{
 for(const [name,type,options] of [['chromium',chromium,{channel:'chrome'}],['firefox',firefox,{}]]){
  const browser=await type.launch({headless:true,...options});const contexts=[],errors=[];
  try{
   async function user(nick,url=base){const context=await browser.newContext({viewport:{width:1366,height:768}});contexts.push(context);await context.route('https://vk.com/js/api/videoplayer.js',r=>r.fulfill({contentType:'application/javascript',body:mock}));await context.route(/https:\/\/(vk.com|vkvideo.ru|vk.ru)\/video_ext.php/,r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html><body style="background:#080a0b;color:#9b9fa3;font:16px sans-serif;text-align:center;padding:100px 0">Тестовый плеер · проверка синхронизации</body></html>'}));const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.fill('#nickname',nick);await page.click('#enter');await page.waitForSelector('#room:not([hidden])');return page;}
   const a=await user('Аня');const url=a.url();const b=await user('Борис',url),c=await user('Катя',url);
   await a.waitForFunction(()=>document.querySelectorAll('.person').length===3);
   await a.screenshot({path:`test-results/room-${name}.png`,fullPage:true});
   assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert.equal(await b.locator('#video-url').isDisabled(),true);
   await a.fill('#message','Привет, друзья!');await a.press('#message','Enter');for(const page of [a,b,c])await page.getByText('Привет, друзья!',{exact:true}).waitFor();
   await b.fill('#message','<img src=x onerror="window.pwned=1">');await b.click('#send-message');await a.getByText('<img src=x onerror="window.pwned=1">',{exact:true}).waitFor();assert.equal(await a.locator('#messages img').count(),0);
   await a.fill('#video-url','<iframe src="https://vk.ru/video_ext.php?oid=-121898133&id=456247731&hash=01643e57e4a2f464"></iframe>');await a.click('#open-video');
   for(const page of [a,b,c])await page.waitForFunction(()=>document.querySelector('#sync-status').textContent.includes('Общая пауза'));
   await a.click('#play');for(const page of [a,b,c])await page.waitForFunction(()=>window.testPlayer.getState()==='playing');
   await a.fill('#seek','2:15');await a.locator('#seek-form button').click();for(const page of [a,b,c])await page.waitForFunction(()=>window.testPlayer.getCurrentTime()>=135&&window.testPlayer.getCurrentTime()<140);
   await a.click('#pause');for(const page of [a,b,c])await page.waitForFunction(()=>window.testPlayer.getState()==='paused');
   const times=await Promise.all([a,b,c].map(p=>p.evaluate(()=>window.testPlayer.getCurrentTime())));assert.ok(Math.max(...times)-Math.min(...times)<1.5);
   await b.reload();await b.waitForSelector('#room:not([hidden])');await b.waitForFunction(()=>window.testPlayer?.getCurrentTime()>=135);
   await c.fill('#message','Третье сообщение');await c.click('#send-message');await a.getByText('Третье сообщение',{exact:true}).waitFor();
   await a.click('#fullscreen');assert.ok(await a.locator('#watch-area').evaluate(el=>el.classList.contains('expanded')&&el.classList.contains('floating-chat')));
   assert.equal(await a.locator('#chat').isVisible(),true);assert.equal(await a.locator('#messages .message:visible').count(),3);
   const overlay=await a.locator('#chat').boundingBox(),screen=await a.locator('#screen').boundingBox();assert.ok(overlay.x>screen.x&&overlay.y>screen.y&&screen.width>1200);
   await a.fill('#message','Ответ из мини-чата');await a.click('#send-message');await b.getByText('Ответ из мини-чата',{exact:true}).waitFor();assert.equal(await a.locator('#messages .message:visible').count(),3);
   await a.screenshot({path:`test-results/floating-chat-${name}.png`});
   await a.click('#chat-mode');assert.ok(await a.locator('#watch-area').evaluate(el=>!el.classList.contains('floating-chat')));assert.equal(await a.locator('#messages .message:visible').count(),4);
   await a.click('#chat-mode');await a.click('#toggle-chat');assert.equal(await a.locator('#chat').isVisible(),false);await a.click('#toggle-chat');assert.equal(await a.locator('#chat').isVisible(),true);
   await a.click('#fullscreen');assert.equal(await a.locator('#player-mount iframe').count(),1);assert.equal(await a.locator('#messages .message:visible').count(),4);
   const serverRoom=app.rooms.get(new URL(url).pathname.split('/').pop());
   const memberB=[...serverRoom.members.values()].find(m=>m.nickname==='Борис');
   for(const ws of memberB.sockets)ws.terminate();
   await b.waitForFunction(()=>document.querySelector('#connection').textContent==='Соединение потеряно');
   await b.waitForFunction(()=>document.querySelector('#connection').classList.contains('online'));
   await a.getByRole('button',{name:'Передать управление: Борис'}).click();await b.waitForFunction(()=>!document.querySelector('#video-url').disabled);await a.waitForFunction(()=>document.querySelector('#video-url').disabled);
   await b.reload();await b.waitForFunction(()=>!document.querySelector('#video-url').disabled&&document.querySelector('#room').hidden===false);
   await c.setViewportSize({width:390,height:844});assert.equal(await c.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await c.screenshot({path:`test-results/mobile-${name}.png`,fullPage:true});
   await c.click('#fullscreen');assert.equal(await c.locator('#messages .message:visible').count(),3);const mobileChat=await c.locator('#chat').boundingBox();const fullViewport=await c.evaluate(()=>({width:innerWidth,height:innerHeight}));assert.ok(mobileChat.x>=0&&mobileChat.x+mobileChat.width<=fullViewport.width&&mobileChat.y>=0&&mobileChat.y+mobileChat.height<=fullViewport.height,JSON.stringify({mobileChat,fullViewport}));await c.screenshot({path:`test-results/floating-mobile-${name}.png`});await c.click('#fullscreen');
   for(let i=0;i<75;i++)app.rooms.message(serverRoom,'Системное сообщение '+i,null);
   await c.reload();await c.waitForSelector('#older:not([hidden])');await c.click('#older');await c.getByText('Системное сообщение 0',{exact:true}).waitFor();
   await c.locator('#messages').evaluate(el=>{el.scrollTop=0;});app.rooms.message(serverRoom,'Новое сообщение внизу',null);await c.waitForSelector('#new-messages:not([hidden])');assert.ok(await c.locator('#messages').evaluate(el=>el.scrollTop<10));await c.click('#new-messages');
   const legacy=await contexts[2].newPage();await legacy.goto(base+'/?legacy=1');assert.ok(await legacy.locator('script[src="/legacy/app.js"]').count());await legacy.screenshot({path:`test-results/welcome-${name}.png`,fullPage:true});await legacy.close();
   assert.deepEqual(errors,[]);results.push({browser:name,status:'passed',cases:['3 independent sessions','chat and XSS text','host permissions','play/pause/seek with mock API','reload','fullscreen and chat','connection restoration','host transfer','mobile layout','legacy bundle'],mockPositionSpread:Math.max(...times)-Math.min(...times)});
  }finally{await browser.close();}
 }
}finally{await app.close();await writeFile('test-results/browser.json',JSON.stringify(results,null,2));}
console.log(JSON.stringify(results,null,2));
