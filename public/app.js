import {Player} from './player.js';
const $=id=>document.getElementById(id);
let roomId=/^\/room\/([\w-]{32})$/.exec(location.pathname)?.[1]||null;
let self,host,state,socket,reconnectTimer,retry=0,stopped=false,connected=false,serverOffset=0,lastPong=Date.now(),pendingControl=null,inflight=false,controlTimer,toastTimer;
let videoKey=null,manualSync=false,joined=false,historyPending=false,oldest=null,messageIds=new Set();
const storage={get(key){try{return localStorage.getItem(key);}catch{return null;}},set(key,value){try{localStorage.setItem(key,value);}catch{}}};
const player=new Player({mount:$('player-mount'),onControl:controlFromPlayer,onNotice:notice,onReady:()=>reconcile(true),onAd:ad=>$('sync-status').textContent=ad?'◷ Реклама · просмотр продолжается':'⟳ Синхронизация',onVideoRejected:()=>{clearTimeout(controlTimer);pendingControl=null;toast('В комнате можно смотреть только видео из ссылки.');}});
function notice(text){$('player-notice').replaceChildren();$('player-notice').hidden=!text;if(!text)return;$('player-notice').append(document.createTextNode(text));if(state?.video){const link=document.createElement('a');link.href=state.video.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Открыть в VK ↗';$('player-notice').append(link);}}
function toast(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,3500);}
function error(text){$(joined?'room-error':'entry-error').textContent=text;}
async function request(path,data){const response=await fetch(path,{method:data?'POST':'GET',credentials:'same-origin',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});const result=await response.json();if(!response.ok)throw new Error(result.error||'Сервер недоступен.');return result;}
function send(data){if(socket?.readyState===WebSocket.OPEN){socket.send(JSON.stringify(data));return true;}error('Нет соединения. Дождитесь повторного подключения.');return false;}
function setConnected(value,label){connected=value;$('connection').textContent=label;$('connection').classList.toggle('online',value);for(const id of ['message','send-message','sync'])$(id).disabled=!value;updatePermissions();}
function updatePermissions(){const isHost=host===self;for(const id of ['video-url','open-video','play','pause','seek'])$(id).disabled=!connected||!isHost;$('seek-form').querySelector('button').disabled=!connected||!isHost;$('playback-controls').hidden=!state?.video||!isHost;$('role-note').textContent=isHost?'Вы ведущий · управление просмотром у вас':'Просмотром управляет ведущий';$('empty-hint').textContent=isHost?'Вставьте ссылку VK Видео выше, а затем пригласите друзей.':'Ведущий скоро выберет видео. А пока можно поздороваться в чате.';}
function renderPeople(members){$('people').replaceChildren();$('online-count').textContent=members.filter(m=>m.online).length+' в комнате';for(const member of members){const el=document.createElement('div');el.className='person'+(!member.online?' offline':'');const avatar=document.createElement('span');avatar.className='avatar';avatar.textContent=member.nickname.slice(0,2).toUpperCase();const name=document.createElement('span');name.textContent=member.nickname+(member.id===self?' (вы)':'');el.append(avatar,name);if(member.host){const badge=document.createElement('span');badge.className='host-label';badge.textContent='ведущий';el.append(badge);}if(!member.online)el.title='Не в сети';if(host===self&&member.id!==self&&member.online){const button=document.createElement('button');button.textContent='♔';button.title='Передать управление: '+member.nickname;button.setAttribute('aria-label',button.title);button.onclick=()=>send({type:'transfer',version:state.version,userId:member.id});el.append(button);}$('people').append(el);}updatePermissions();}
function nearBottom(){const el=$('messages');return el.scrollHeight-el.scrollTop-el.clientHeight<65;}
function scrollBottom(){$('messages').scrollTop=$('messages').scrollHeight;$('new-messages').hidden=true;}
function messageNode(m){const el=document.createElement('div');el.dataset.id=m.id;if(!m.nickname){el.className='system-message';el.textContent=m.text;}else{el.className='message'+(m.userId===self?' mine':'');const header=document.createElement('header'),name=document.createElement('span'),time=document.createElement('time'),body=document.createElement('p');name.textContent=m.nickname;time.dateTime=new Date(m.time).toISOString();time.textContent='· '+new Date(m.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});body.textContent=m.text;header.append(name,time);el.append(header,body);}return el;}
function messages(items,{reset=false,prepend=false}={}){const list=$('messages');const atBottom=nearBottom(),height=list.scrollHeight,top=list.scrollTop;if(reset){list.replaceChildren();messageIds.clear();oldest=null;}if(items.length)$('chat-placeholder')?.remove();const fragment=document.createDocumentFragment();let added=0;for(const m of items){if(messageIds.has(m.id))continue;messageIds.add(m.id);oldest=oldest===null?m.id:Math.min(oldest,m.id);fragment.append(messageNode(m));added++;}if(prepend)list.prepend(fragment);else list.append(fragment);let removedHeight=0;while(list.children.length>200){const el=list.firstElementChild;removedHeight+=el.getBoundingClientRect().height;messageIds.delete(Number(el.dataset.id));el.remove();}if(prepend)list.scrollTop=top+list.scrollHeight-height;else if(reset||atBottom)scrollBottom();else{list.scrollTop=Math.max(0,top-removedHeight);if(added)$('new-messages').hidden=false;}}
function currentPosition(){return Math.max(0,(state?.position||0)+(state?.playing?Math.max(0,Date.now()+serverOffset-state.updatedAt)/1000:0));}
function formatTime(seconds){const s=Math.max(0,Math.floor(seconds));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}
function reconcile(force=false){if(!state?.video||!connected)return;if(player.ad){$('sync-status').textContent='◷ Реклама · вернёмся к общему моменту';return;}if(inflight&&!force)return;const delta=player.apply(state,currentPosition(),force);$('position').textContent=formatTime(currentPosition());$('sync-status').textContent=delta===undefined?'○ Ожидаем плеер VK':delta>1.5?'⟳ Выравниваем позицию':'● '+(state.playing?'Смотрим вместе':'Общая пауза');}
function applyState(next,force=false){if(state&&next.version<state.version)return;state=next;const key=next.video?.embed||null;updatePermissions();if(key!==videoKey){videoKey=key;pendingControl=null;inflight=false;$('empty-screen').hidden=!!key;if(key){$('video-url').value=next.video.url;notice('Загружаем плеер VK…');player.open(next.video);}else{player.destroy();notice('');}}else reconcile(force);}
function queueControl(data){pendingControl=data;clearTimeout(controlTimer);controlTimer=setTimeout(flushControl,120);}
function flushControl(){if(!pendingControl||inflight||!connected||host!==self||!state)return;const command=pendingControl;pendingControl=null;inflight=send({type:'control',...command,version:state.version});}
function controlFromPlayer(data){if(!connected)return;if(host===self)queueControl(data);else reconcile(true);}
function connect(){
  if(stopped||!roomId)return;
  clearTimeout(reconnectTimer);setConnected(false,retry?'Переподключаемся…':'Подключаемся…');
  const old=socket;
  socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
  const active=socket;old?.close();
  socket.onopen=()=>{if(socket!==active)return;socket.send(JSON.stringify({type:'join',roomId}));lastPong=Date.now();};
  socket.onmessage=event=>{
    if(socket!==active)return;
    let data;try{data=JSON.parse(event.data);}catch{return;}
    if(data.type==='snapshot'){
      retry=0;joined=true;inflight=false;pendingControl=null;self=data.self;host=data.host;serverOffset=data.serverTime-Date.now();
      $('welcome').hidden=true;$('room').hidden=false;$('room-code').textContent='#'+roomId.slice(0,6).toUpperCase();setConnected(true,'В комнате');renderPeople(data.members);messages(data.messages,{reset:true});$('older').hidden=!data.hasOlder;applyState(data.state,true);send({type:'ping',clientTime:Date.now()});
    }else if(data.type==='presence'){host=data.host;renderPeople(data.members);if(host!==self){pendingControl=null;inflight=false;}}
    else if(data.type==='state'){const wasInflight=inflight;inflight=false;const queued=pendingControl;applyState(data.state,!!data.manual||manualSync);manualSync=false;if(wasInflight&&queued){pendingControl=queued;flushControl();}}
    else if(data.type==='message'){if(joined)messages([data.message]);}
    else if(data.type==='history'){historyPending=false;messages(data.messages,{prepend:true});$('older').disabled=false;$('older').hidden=!data.hasOlder;}
    else if(data.type==='pong'){lastPong=Date.now();const rtt=Date.now()-data.clientTime;if(rtt<5000)serverOffset=data.serverTime+rtt/2-Date.now();}
    else if(data.type==='error'){inflight=false;pendingControl=null;error(data.message);if(data.join){stopped=true;socket.close();$('welcome').hidden=false;$('entry-error').textContent=data.message;$('enter').disabled=false;setConnected(false,'Не подключено');}}
  };
  socket.onclose=()=>{if(socket!==active)return;inflight=false;pendingControl=null;historyPending=false;$('older').disabled=false;setConnected(false,stopped?'Не подключено':'Соединение потеряно');if(!stopped){const delay=Math.min(30000,1000*2**Math.min(retry++,5))+Math.random()*500;reconnectTimer=setTimeout(connect,delay);}};
  socket.onerror=()=>{};
}
$('entry-form').addEventListener('submit',async event=>{event.preventDefault();$('entry-error').textContent='';$('enter').disabled=true;try{const session=await request('/api/session',{nickname:$('nickname').value});self=session.id;storage.set('nickname',session.nickname);if(!roomId){const room=await request('/api/rooms',{});roomId=room.id;history.pushState(null,'','/room/'+roomId+(location.search.includes('legacy=1')?'?legacy=1':''));}stopped=false;connect();}catch(e){error(e.message);$('enter').disabled=false;}});
$('video-form').addEventListener('submit',event=>{event.preventDefault();$('room-error').textContent='';if(inflight){toast('Дождитесь применения предыдущей команды.');return;}if(state?.video && $('video-url').value.trim()===state.video.url){player.open(state.video);return;}send({type:'video',version:state.version,url:$('video-url').value});});
$('chat-form').addEventListener('submit',event=>{event.preventDefault();const text=$('message').value;if(!text.trim())return;if(send({type:'chat',text}))$('message').value='';});
$('message').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('chat-form').requestSubmit();}});
$('messages').addEventListener('scroll',()=>{if(nearBottom())$('new-messages').hidden=true;});
$('new-messages').onclick=scrollBottom;
$('older').onclick=()=>{if(historyPending||oldest===null)return;historyPending=send({type:'history',before:oldest});$('older').disabled=historyPending;};
$('sync').onclick=()=>{manualSync=true;send({type:'sync'});};
$('play').onclick=()=>queueControl({position:currentPosition(),playing:true});
$('pause').onclick=()=>queueControl({position:currentPosition(),playing:false});
$('seek-form').onsubmit=event=>{event.preventDefault();const value=$('seek').value.trim();if(!/^\d+(?::[0-5]\d){0,2}$/.test(value)){error('Введите секунды или время в формате 12:30.');return;}const position=value.split(':').reduce((n,p)=>n*60+Number(p),0);queueControl({position,playing:state.playing});};
$('invite').onclick=async()=>{const link=location.origin+'/room/'+roomId;try{if(!navigator.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText(link);toast('Приглашение скопировано. Отправьте его друзьям.');}catch{$('invite-fallback').hidden=false;$('invite-link').value=link;$('invite-link').focus();$('invite-link').select();}};
const watch=$('watch-area');
let normalChatScroll=0;
function floatingMessages(){
  const all=[...$('messages').children];
  const userMessages=all.filter(el=>el.classList.contains('message'));
  const recent=(userMessages.length?userMessages:all).slice(-3);
  for(const el of all)el.classList.toggle('float-visible',recent.includes(el));
}
function chatMode(floating){
  watch.classList.toggle('floating-chat',floating);
  $('chat-mode').textContent=floating?'Вся история':'Мини-чат';
  floatingMessages();
  if(floating)scrollBottom();
}
function expanded(value){
  if(value&&!watch.classList.contains('expanded'))normalChatScroll=$('messages').scrollTop;
  watch.classList.toggle('expanded',value);document.body.classList.toggle('fullscreen',value);
  watch.classList.toggle('show-chat',value);chatMode(value);
  $('toggle-chat').setAttribute('aria-pressed',String(value));
  $('fullscreen').querySelector('span').textContent=value?'Свернуть':'Полный экран';
  if(!value)$('messages').scrollTop=normalChatScroll;
}
$('fullscreen').onclick=async()=>{if(watch.classList.contains('expanded')){if(document.fullscreenElement&&document.exitFullscreen)await document.exitFullscreen().catch(()=>{});expanded(false);}else{expanded(true);if(watch.requestFullscreen)await watch.requestFullscreen().catch(()=>toast('Полный экран открыт в пределах окна.'));}};
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement)expanded(false);});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.fullscreenElement)expanded(false);});
$('toggle-chat').onclick=()=>{const shown=watch.classList.toggle('show-chat');$('toggle-chat').setAttribute('aria-pressed',String(shown));if(shown)scrollBottom();};
$('chat-mode').onclick=()=>chatMode(!watch.classList.contains('floating-chat'));
// Update only chat classes; the player and its connection are never recreated.
new MutationObserver(()=>{if(watch.classList.contains('floating-chat')){floatingMessages();scrollBottom();}}).observe($('messages'),{childList:true});
window.addEventListener('online',()=>{if(!connected&&roomId&&!stopped){socket?.close();clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,100);}});
window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(reconnectTimer);socket?.close();player.destroy();});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
window.addEventListener('popstate',()=>location.reload());
setInterval(()=>{if(connected){if(Date.now()-lastPong>20000){socket?.close();return;}send({type:'ping',clientTime:Date.now()});reconcile();}},5000);
if(roomId){$('entry-title').textContent='Вас ждут в кинокомнате';$('entry-description').textContent='Представьтесь и присоединяйтесь к просмотру.';$('enter').firstChild.textContent='Присоединиться ';}
$('nickname').value=storage.get('nickname')||'';
request('/api/session').then(session=>{if(session.id){self=session.id;$('nickname').value=session.nickname;if(roomId)connect();}}).catch(()=>error('Не удалось связаться с сервером. Проверьте подключение и обновите страницу.'));
