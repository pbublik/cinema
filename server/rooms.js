import { randomBytes } from 'node:crypto';
import { parseVideo } from './video.js';
const id = () => randomBytes(24).toString('base64url');
export function nickname(value) {
  const name=typeof value==='string' ? value.normalize('NFKC').trim() : '';
  if (!/^[\p{L}\p{N}_ .-]{2,24}$/u.test(name)) throw new Error('Никнейм: 2–24 символа — буквы, цифры, пробел, точка, дефис или _.');
  return name;
}
export class Rooms {
  constructor({now=Date.now, grace=60000, changed=()=>{}}={}) {this.rooms=new Map();this.now=now;this.grace=grace;this.changed=changed;}
  create(session) {
    const room={id:id(),host:session.id,members:new Map(),messages:[],nextMessage:1,state:{video:null,position:0,playing:false,updatedAt:this.now(),version:0},emptyAt:null,createdAt:this.now()};
    this.rooms.set(room.id,room); this.changed(); return room;
  }
  get(roomId) { const room=this.rooms.get(roomId); if(!room) throw new Error('Комната не найдена или уже закрыта. Создайте новую.'); return room; }
  join(room,session,socket) {
    if (room.members.size>=100 && !room.members.has(session.id)) throw new Error('Комната заполнена.');
    const name=nickname(session.nickname);
    for(const m of room.members.values()) if(m.id!==session.id && m.nickname.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru')) throw new Error('Этот никнейм уже занят в комнате. Выберите другой.');
    let member=room.members.get(session.id);
    if(!member) {member={id:session.id,nickname:name,joinedAt:this.now(),sockets:new Set(),offlineAt:null,chatTimes:[]};room.members.set(member.id,member);}
    const wasOffline=member.sockets.size===0;
    if(wasOffline) member.connectedAt=this.now();
    member.nickname=name;member.sockets.add(socket);member.offlineAt=null;room.emptyAt=null;
    if(!room.host) room.host=member.id;
    if(wasOffline) this.message(room,`${name} присоединился к просмотру.`,null);
    this.changed();return member;
  }
  leave(room,member,socket) {
    member.sockets.delete(socket);
    if(member.sockets.size) return;
    member.offlineAt=this.now();this.message(room,`${member.nickname} отключился.`,null);
    if(![...room.members.values()].some(m=>m.sockets.size)) room.emptyAt=this.now();
    this.changed();
  }
  message(room,text,member) {
    if(member) {
      if(typeof text!=='string'||!text.trim()||text.length>2000) throw new Error('Сообщение должно содержать от 1 до 2000 символов.');
      member.chatTimes=member.chatTimes.filter(t=>t>this.now()-5000);
      if(member.chatTimes.length>=5) throw new Error('Слишком много сообщений. Подождите несколько секунд.');
      member.chatTimes.push(this.now());
    }
    const message={id:room.nextMessage++,text:member?text.trim():text,nickname:member?.nickname||null,userId:member?.id||null,time:this.now()};
    room.messages.push(message);room.messages=room.messages.slice(-200);this.broadcast(room,{type:'message',message});this.changed();return message;
  }
  broadcast(room,data) { for(const m of room.members.values()) for(const socket of m.sockets) { if(socket.readyState===1) {if(socket.bufferedAmount>1024*1024) socket.close(1013,'Slow connection'); else socket.send(JSON.stringify(data));} } }
  people(room) {return [...room.members.values()].map(m=>({id:m.id,nickname:m.nickname,online:m.sockets.size>0,host:m.id===room.host}));}
  presence(room) {this.broadcast(room,{type:'presence',host:room.host,members:this.people(room)});}
  snapshot(room) {return {type:'snapshot',roomId:room.id,host:room.host,members:this.people(room),state:room.state,serverTime:this.now(),messages:room.messages.slice(-50),hasOlder:room.messages.length>50};}
  command(room,member,data) {
    if(room.host!==member.id) throw new Error('Управлять просмотром может только ведущий.');
    if(data.version!==room.state.version) { const error=new Error('Состояние изменилось. Повторите действие.');error.stale=true;throw error; }
    if(data.type==='transfer') {
      const target=room.members.get(data.userId);if(!target?.sockets.size) throw new Error('Участник сейчас не в сети.');
      room.host=target.id;room.state={...room.state,version:room.state.version+1};
      this.message(room,`${target.nickname} теперь ведущий.`,null);this.presence(room);
    } else if(data.type==='video') room.state={video:parseVideo(data.url),position:0,playing:false,updatedAt:this.now(),version:room.state.version+1};
    else if(data.type==='control') {
      if(!room.state.video) throw new Error('Сначала откройте видео.');
      if(!Number.isFinite(data.position)||data.position<0||data.position>604800||typeof data.playing!=='boolean') throw new Error('Некорректная команда плеера.');
      room.state={...room.state,position:data.position,playing:data.playing,updatedAt:this.now(),version:room.state.version+1};
    } else throw new Error('Неизвестная команда.');
    this.broadcast(room,{type:'state',state:room.state,serverTime:this.now()});this.changed();
  }
  tick() {
    for(const room of this.rooms.values()) {
      const host=room.members.get(room.host);
      if(!host || (!host.sockets.size && host.offlineAt!==null && this.now()-host.offlineAt>=this.grace)) {
        const next=[...room.members.values()].filter(m=>m.sockets.size).sort((a,b)=>a.connectedAt-b.connectedAt)[0];
        if(next && room.host!==next.id) {room.host=next.id;room.state.version++;this.message(room,`${next.nickname} теперь ведущий.`,null);this.presence(room);this.broadcast(room,{type:'state',state:room.state,serverTime:this.now()});}
      }
      if(room.emptyAt!==null&&this.now()-room.emptyAt>86400000) {this.rooms.delete(room.id);this.changed();}
    }
  }
  serialize() {return [...this.rooms.values()].map(r=>({...r,members:[...r.members.values()].map(({sockets,chatTimes,...m})=>m)}));}
  restore(data=[]) {for(const r of data) {r.members=new Map(r.members.map(m=>[m.id,{...m,sockets:new Set(),chatTimes:[],offlineAt:this.now()}]));r.emptyAt=this.now();this.rooms.set(r.id,r);}}
}
