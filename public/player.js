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
  constructor({mount,onControl,onNotice,onReady,onAd,onVideoRejected=()=>{}}){Object.assign(this,{mount,onControl,onNotice,onReady,onAd,onVideoRejected});this.generation=0;this.ready=false;this.ad=false;this.suppressUntil=0;this.restoreAttempts=0;}
  async open(video,{restoring=false}={}){
    if(!restoring)this.restoreAttempts=0;
    this.destroy();const generation=this.generation;
    try {
      await loadAPI();if(generation!==this.generation)return;
      const frame=document.createElement('iframe');frame.title='Плеер VK Видео';frame.allow='autoplay; encrypted-media; fullscreen; picture-in-picture';frame.allowFullscreen=true;frame.src=video.embed;
      // Initialize after navigation; a postMessage sent to about:blank would be lost.
      const loaded=new Promise(resolve=>{frame.onload=resolve;});this.mount.replaceChildren(frame);
      this.loadTimer=setTimeout(()=>{if(!this.ready)this.onNotice('VK не подтвердил готовность плеера. Если видео недоступно, скопируйте в VK «Поделиться → Экспортировать» и вставьте код в поле сверху. Также проверьте сеть и поддержку видео браузером.');},18000);
      await loaded;if(generation!==this.generation)return;
      this.api=window.VK.VideoPlayer(frame);
      const on=(event,handler)=>this.api.on(event,data=>{if(generation===this.generation)handler(data);});
      const restoreSelected=()=>{
        // Never publish playback events from a recommendation as room controls.
        this.ready=false;
        this.onVideoRejected();
        try{this.api?.pause();}catch{}
        if(++this.restoreAttempts>2){this.destroy();this.onNotice('VK переключает ролик вместо выбранного. Повторно откройте видео по ссылке комнаты.');return;}
        // Removing the old iframe stops the unwanted video and its audio immediately.
        this.open(video,{restoring:true});
      };
      on('recommendationClicked',restoreSelected);
      on('inited',data=>{
        // VK may report ownerId_videoId or just the numeric video id.
        const reported=String(data?.videoId??'').replace(/^video/,'');
        const selected=video.id;
        if(/^-?\d+_\d+$/.test(reported)?reported!==selected:/^\d+$/.test(reported)&&reported!==selected.split('_')[1]){restoreSelected();return;}
        clearTimeout(this.loadTimer);this.restoreAttempts=0;this.ready=true;this.onNotice('');this.onReady();
      });
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
