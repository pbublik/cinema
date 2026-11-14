import {WebSocket} from 'ws';
import {createApp} from '../server/index.js';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
// Real-duration room/chat/server soak, not a substitute for real video/Windows 7 tests.
const seconds=Number(process.env.SOAK_SECONDS||7200);
if(!Number.isFinite(seconds)||seconds<5)throw new Error('SOAK_SECONDS must be >= 5');
const app=await createApp({dataDir:null});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${app.server.address().port}`,clients=[],samples=[];let duplicates=0,messageCount=0,timer;
try{
 let roomId;
 for(let i=0;i<3;i++){
  const res=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nickname:'Зритель '+i})});const cookie=res.headers.get('set-cookie').split(';')[0];
  if(!roomId){const roomRes=await fetch(base+'/api/rooms',{method:'POST',headers:{cookie}});roomId=(await roomRes.json()).id;}
  const ws=new WebSocket(base.replace('http','ws')+'/ws',{headers:{cookie}}),seen=new Set();let ready;
  const joined=new Promise(r=>ready=r);
  ws.on('message',raw=>{const event=JSON.parse(raw);if(event.type==='snapshot')ready();if(event.type==='message'&&event.message.userId){if(seen.has(event.message.id))duplicates++;seen.add(event.message.id);messageCount++;}});
  await new Promise(r=>ws.once('open',r));ws.send(JSON.stringify({type:'join',roomId}));await joined;clients.push(ws);
 }
 const started=Date.now();let seq=0;
 timer=setInterval(()=>{const room=app.rooms.get(roomId);for(const ws of clients)ws.send(JSON.stringify({type:'chat',text:'Сообщение '+seq}));seq++;if(seq%5===0){global.gc?.();const sample={elapsed:Math.round((Date.now()-started)/1000),heap:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss,messages:room.messages.length,sockets:[...room.members.values()].reduce((n,m)=>n+m.sockets.size,0)};samples.push(sample);if(seq%30===0)console.log(JSON.stringify(sample));}},1000);
 await new Promise(r=>setTimeout(r,seconds*1000));clearInterval(timer);await new Promise(r=>setTimeout(r,100));
 const room=app.rooms.get(roomId);assert.equal(duplicates,0);assert.equal([...room.members.values()].reduce((n,m)=>n+m.sockets.size,0),3);assert.ok(room.messages.length<=200);
 const result={durationSeconds:seconds,duplicates,messageCount,retainedMessages:room.messages.length,samples,scope:'Node room/chat service only; no real VK or browser memory measurement'};await mkdir('test-results',{recursive:true});await writeFile('test-results/soak.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,samples:undefined}));
}finally{clearInterval(timer);for(const ws of clients)ws.terminate();await app.close();}
