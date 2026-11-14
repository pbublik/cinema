import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {createApp} from '../server/index.js';
test('real HTTP and WebSocket: three sessions, broadcast, version control, reconnect and origins',async()=>{
 const app=await createApp({dataDir:null});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`,clients=[];
 try{
  async function session(name){const r=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nickname:name})});return{cookie:r.headers.get('set-cookie').split(';')[0],...await r.json()};}
  const users=await Promise.all(['Анна','Борис','Катя'].map(session));
  const response=await fetch(base+'/api/rooms',{method:'POST',headers:{cookie:users[0].cookie}}),room=await response.json();
  assert.equal(room.id.length,32);
  async function connect(user){const ws=new WebSocket(base.replace('http','ws')+'/ws',{headers:{cookie:user.cookie,origin:base}});const events=[];ws.on('message',raw=>events.push(JSON.parse(raw)));await new Promise(r=>ws.once('open',r));clients.push(ws);const wait=async(type,predicate=()=>true)=>{const end=Date.now()+3000;while(Date.now()<end){const index=events.findIndex(e=>e.type===type&&predicate(e));if(index>=0)return events.splice(index,1)[0];await new Promise(r=>setTimeout(r,10));}throw new Error('Missing event '+type);};ws.send(JSON.stringify({type:'join',roomId:room.id}));return{ws,wait,snapshot:await wait('snapshot')};}
  const [a,b,c]=await Promise.all(users.map(connect));assert.equal(a.snapshot.host,users[0].id);
  a.ws.send(JSON.stringify({type:'chat',text:'<img src=x onerror=alert(1)>'}));for(const p of [a,b,c])assert.equal((await p.wait('message',m=>!!m.message.nickname)).message.text,'<img src=x onerror=alert(1)>');
  b.ws.send(JSON.stringify({type:'video',version:0,url:'https://vk.com/video-1_2'}));assert.match((await b.wait('error')).message,/ведущий/);
  a.ws.send(JSON.stringify({type:'video',version:0,url:'https://vk.com/video-1_2'}));for(const p of [a,b,c])assert.equal((await p.wait('state')).state.version,1);
  a.ws.send(JSON.stringify({type:'control',version:1,position:120,playing:true}));for(const p of [a,b,c])assert.equal((await p.wait('state')).state.position,120);
  a.ws.send(JSON.stringify({type:'control',version:1,position:0,playing:false}));assert.equal((await a.wait('error')).stale,true);
  a.ws.close();await new Promise(r=>a.ws.once('close',r));const returned=await connect(users[0]);assert.equal(returned.snapshot.host,users[0].id);assert.equal(returned.snapshot.state.playing,true);
  const denied=await fetch(base+'/api/rooms',{method:'POST',headers:{cookie:users[0].cookie,origin:'https://evil.invalid'}});assert.equal(denied.status,403);
 }finally{for(const ws of clients)ws.terminate();await app.close();}
});
