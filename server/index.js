import { createServer } from 'node:http';
import { randomBytes,createHash } from 'node:crypto';
import { readFile,mkdir,writeFile,rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Rooms,nickname } from './rooms.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function createApp({dataDir=path.join(root,'data'),grace=60000}={}) {
  const sessions=new Map(), limits=new Map();let saveTimer, saving=Promise.resolve(),closing=false;
  const rooms=new Rooms({grace,changed:scheduleSave});
  function scheduleSave(){if(!saveTimer&&!closing)saveTimer=setTimeout(()=>{saveTimer=null;save();},250);}
  function save(){if(!dataDir)return Promise.resolve();const json=JSON.stringify({rooms:rooms.serialize(),sessions:[...sessions]});saving=saving.then(async()=>{await mkdir(dataDir,{recursive:true});await writeFile(path.join(dataDir,'state.tmp'),json,{mode:0o600});await rename(path.join(dataDir,'state.tmp'),path.join(dataDir,'state.json'));}).catch(e=>console.error('Не удалось сохранить комнаты:',e.message));return saving;}
  if(dataDir)try {const data=JSON.parse(await readFile(path.join(dataDir,'state.json'),'utf8'));rooms.restore(data.rooms);for(const [key,value] of data.sessions)if(value.expires>Date.now())sessions.set(key,value);}catch(e){if(e.code!=='ENOENT')throw e;}
  const digest=value=>createHash('sha256').update(value).digest('hex');
  function session(req){const token=/(?:^|;\s*)vmeste=([A-Za-z0-9_-]+)/.exec(req.headers.cookie||'')?.[1];const s=token&&sessions.get(digest(token));return s?.expires>Date.now()?s:null;}
  function sameOrigin(req){if(!req.headers.origin)return true;try{return new URL(req.headers.origin).host===req.headers.host&&(!process.env.PUBLIC_ORIGIN||req.headers.origin===process.env.PUBLIC_ORIGIN);}catch{return false;}}
  function rate(req){const key=req.socket.remoteAddress;let l=limits.get(key);if(!l||l.until<Date.now()){l={count:0,until:Date.now()+60000};limits.set(key,l);}return ++l.count<=100;}
  function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
  async function body(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>8192)throw new Error('Запрос слишком большой.');}return JSON.parse(text||'{}');}
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://vk.com https://vk.ru https://vkvideo.ru; frame-src https://vk.com https://vk.ru https://vkvideo.ru; connect-src 'self' ws: wss:; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url=new URL(req.url,'http://localhost');
      if(url.pathname.startsWith('/api/')) {
        if(!sameOrigin(req))return json(res,403,{error:'Недопустимый источник запроса.'});
        if(req.method==='GET'&&url.pathname==='/api/session'){const s=session(req);return json(res,200,s?{id:s.id,nickname:s.nickname}:{id:null});}
        if(req.method!=='POST')return json(res,405,{error:'Метод не поддерживается.'});
        if(!rate(req))return json(res,429,{error:'Слишком много запросов. Повторите через минуту.'});
        if(url.pathname==='/api/session') {
          const data=await body(req),name=nickname(data.nickname);let s=session(req);
          if(s){s.nickname=name;s.expires=Date.now()+30*86400000;}
          else{const token=randomBytes(32).toString('base64url');s={id:randomBytes(18).toString('base64url'),nickname:name,expires:Date.now()+30*86400000};sessions.set(digest(token),s);res.setHeader('Set-Cookie',`vmeste=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${process.env.COOKIE_SECURE==='1'?'; Secure':''}`);}
          scheduleSave();return json(res,200,{id:s.id,nickname:s.nickname});
        }
        if(url.pathname==='/api/rooms'){const s=session(req);if(!s)return json(res,401,{error:'Сначала введите никнейм.'});if(rooms.rooms.size>=5000)return json(res,503,{error:'Сервер заполнен. Попробуйте позже.'});return json(res,201,{id:rooms.create(s).id});}
        return json(res,404,{error:'Не найдено.'});
      }
      if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end();}
      const assets={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/legacy/app.js':'legacy/app.js','/legacy/':'legacy/index.html','/favicon.svg':'favicon.svg'};
      let name=/^\/room\/[\w-]{32}$/.test(url.pathname)?'index.html':assets[url.pathname];
      if(name==='index.html'&&url.searchParams.get('legacy')==='1')name='legacy/index.html';
      if(!name){res.writeHead(404);return res.end('Not found');}
      const file=await readFile(path.join(root,'dist',name));res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'})[path.extname(name)]);res.setHeader('Cache-Control','no-cache');res.end(req.method==='HEAD'?undefined:file);
    }catch(e){json(res,400,{error:e.code==='ENOENT'?'Сначала выполните npm run build.':e.message});}
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:16384,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{const s=session(req);if(!s||!sameOrigin(req)||req.url!=='/ws'){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,s));});
  wss.on('connection',(ws,s)=>{
    let room,member,count=0,windowStart=Date.now();ws.alive=true;
    const joinTimeout=setTimeout(()=>{if(!room)ws.close(1008,'Join timeout');},10000);
    ws.on('pong',()=>ws.alive=true);
    ws.on('error',()=>{});
    ws.on('message',raw=>{
      try {
        if(Date.now()-windowStart>10000){count=0;windowStart=Date.now();}if(++count>100)throw new Error('Слишком много событий.');
        const data=JSON.parse(raw);if(!data||typeof data.type!=='string')throw new Error('Некорректное событие.');
        if(data.type==='join') {if(room)throw new Error('Вы уже в комнате.');const target=rooms.get(data.roomId);member=rooms.join(target,s,ws);room=target;clearTimeout(joinTimeout);ws.send(JSON.stringify({...rooms.snapshot(room),self:s.id}));rooms.presence(room);return;}
        if(!room)throw new Error('Сначала подключитесь к комнате.');
        if(data.type==='ping')ws.send(JSON.stringify({type:'pong',clientTime:data.clientTime,serverTime:Date.now()}));
        else if(data.type==='sync')ws.send(JSON.stringify({type:'state',state:room.state,serverTime:Date.now(),manual:true}));
        else if(data.type==='chat')rooms.message(room,data.text,member);
        else if(data.type==='history'){const messages=room.messages.filter(m=>m.id<Number(data.before)).slice(-50);ws.send(JSON.stringify({type:'history',messages,hasOlder:!!messages.length&&room.messages[0].id<messages[0].id}));}
        else rooms.command(room,member,data);
      }catch(e){ws.send(JSON.stringify({type:'error',message:e.message,join:!room,stale:!!e.stale}));if(e.stale&&room)ws.send(JSON.stringify({type:'state',state:room.state,serverTime:Date.now(),manual:true}));}
    });
    ws.on('close',()=>{clearTimeout(joinTimeout);if(room){rooms.leave(room,member,ws);rooms.presence(room);}});
  });
  const tick=setInterval(()=>rooms.tick(),1000);
  const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive)ws.terminate();else{ws.alive=false;ws.ping();}}for(const [key,s]of sessions)if(s.expires<Date.now())sessions.delete(key);for(const [key,v]of limits)if(v.until<Date.now())limits.delete(key);},30000);
  async function close(){closing=true;clearTimeout(saveTimer);clearInterval(tick);clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));await save();}
  return {server,rooms,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createApp();const port=Number(process.env.PORT||3000),host=process.env.HOST||'0.0.0.0';
  app.server.listen(port,host,()=>console.log(`CINEMA: http://localhost:${port}`));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});
}
