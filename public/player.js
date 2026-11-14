let apiPromise;
function loadAPI() {
  if(window.VK?.VideoPlayer)return Promise.resolve();
  if(apiPromise)return apiPromise;
  apiPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='https://vk.com/js/api/videoplayer.js';
    const timer=setTimeout(()=>{script.remove();apiPromise=null;reject(new Error('VK не ответил. Проверьте подключение и попробуйте открыть видео ещё раз.'));},15000);
    script.onload=()=>{clearTimeout(timer);if(window.VK?.VideoPlayer)resolve();else{apiPromise=null;reject(new Error('API плеера VK недоступен в этом браузере.'));}};
    script.onerror=()=>{clearTimeout(timer);script.remove();apiPromise=null;reject(new Error('Не удалось загрузить плеер VK. Проверьте сеть или блокировщик содержимого.'));};
    document.head.appendChild(script);
  });return apiPromise;
}
export class Player {
  constructor({mount,onControl,onNotice,onReady,onAd}){Object.assign(this,{mount,onControl,onNotice,onReady,onAd});this.generation=0;this.ready=false;this.ad=false;this.suppressUntil=0;this.pending=null;}
  async open(video){
    this.destroy();const generation=this.generation;
    try {
      await loadAPI();if(generation!==this.generation)return;
      const frame=document.createElement('iframe');frame.title='Плеер VK Видео';frame.allow='autoplay; encrypted-media; fullscreen; picture-in-picture';frame.allowFullscreen=true;frame.src=video.embed;
      // Initialize after navigation; a postMessage sent to about:blank would be lost.
      const loaded=new Promise(resolve=>{frame.onload=resolve;});this.mount.replaceChildren(frame);
      this.loadTimer=setTimeout(()=>{if(!this.ready)this.onNotice('VK не подтвердил готовность плеера. Если видео недоступно, скопируйте в VK «Поделиться → Экспортировать» и вставьте код в поле сверху. Также проверьте сеть и поддержку видео браузером.');},18000);
      await loaded;if(generation!==this.generation)return;
      this.api=window.VK.VideoPlayer(frame);
      const on=(event,handler)=>this.api.on(event,handler);
      on('inited',()=>{clearTimeout(this.loadTimer);this.ready=true;this.onNotice('');this.onReady();});
      for(const event of ['started','resumed','paused','seeked','ended'])on(event,data=>{
        if(!this.ready||this.ad||Date.now()<this.suppressUntil)return;
        this.onControl({position:this.api.getCurrentTime(),playing:event==='paused'||event==='ended'?false:event==='started'||event==='resumed'?true:data.state==='playing'});
      });
      on('error',()=>{this.ready=false;this.onNotice('VK не может воспроизвести это видео (код '+this.api.getErrorCode()+'). Оно может быть закрыто, удалено или недоступно для встраивания.');});
      on('autoplaySoundProhibited',()=>this.onNotice('Браузер остановил автоматический запуск со звуком. Нажмите Play внутри плеера, затем «Синхронизироваться».'));
      on('adStarted',()=>{this.ad=true;this.onAd(true);this.onNotice('Сейчас у вас реклама. Остальные продолжают просмотр; после рекламы вернёмся к общему моменту.');});
      on('adCompleted',()=>{this.ad=false;this.suppressUntil=Date.now()+1200;this.onAd(false);this.onNotice('');this.onReady();});
    }catch(e){if(generation===this.generation)this.onNotice(e.message);}
  }
  apply(state,target,force=false){
    if(!this.api||!this.ready||this.ad)return;
    const actual=this.api.getCurrentTime(),playing=this.api.getState()==='playing';
    const duration=this.api.getDuration();if(duration>0)target=Math.min(target,duration);
    if(force||Math.abs(actual-target)>1.5||playing!==state.playing){
      this.suppressUntil=Date.now()+1200;
      if(force||Math.abs(actual-target)>1.5)this.api.seek(Math.max(0,target));
      if(playing!==state.playing){if(state.playing)this.api.play();else this.api.pause();}
    }
    return Math.abs(actual-target);
  }
  destroy(){this.generation++;clearTimeout(this.loadTimer);this.api?.destroy();this.api=null;this.ready=false;this.ad=false;this.mount.replaceChildren();}
}
