import { chromium, firefox } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
const video = process.env.VK_TEST_EMBED || 'https://vk.ru/video_ext.php?oid=-121898133&id=456247731&hash=01643e57e4a2f464&js_api=1';
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<!doctype html><html><body><button id="play">Play</button><button id="pause">Pause</button><button id="seek">Seek 30</button><button id="full">Fullscreen</button><iframe id="video" width="800" height="450" allow="autoplay; fullscreen" src="${video.replaceAll('&','&amp;')}"></iframe><script src="https://vk.com/js/api/videoplayer.js"></script><script>window.events=[];window.addEventListener('load',()=>{if(!window.VK)return;window.player=VK.VideoPlayer(document.querySelector('iframe'));Object.values(VK.VideoPlayer.Events).forEach(e=>player.on(e,d=>events.push({event:e,data:d})));document.querySelector('#play').onclick=()=>player.play();document.querySelector('#pause').onclick=()=>player.pause();document.querySelector('#seek').onclick=()=>player.seek(30);document.querySelector('#full').onclick=()=>document.body.requestFullscreen();});</script></body></html>`); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
await mkdir('test-results', {recursive:true});
const results=[];
for (const [name, type, options] of [['chromium',chromium,{channel:'chrome'}],['firefox',firefox,{}]]) {
  let browser;
  try {
    browser=await type.launch({headless:true,...options});
    const page=await browser.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.player, null, {timeout:20000});
    await page.waitForFunction(()=>events.some(e=>e.event==='inited'), null, {timeout:20000}).catch(()=>{});
    for(const id of ['play','seek','pause','full']) {await page.click('#'+id); await page.waitForTimeout(1500);}
    const state=await page.evaluate(()=>({events, state:player.getState(),time:player.getCurrentTime(),fullscreen:!!document.fullscreenElement}));
    const embedFrame=page.frames().find(f=>f.url().includes('video_ext.php')||f.url().includes('video_embed.php'));
    state.visiblePlayerText=await embedFrame?.locator('body').innerText({timeout:3000}).catch(()=>null);
    results.push({browser:name,video,...state,errors});
    await page.screenshot({path:`test-results/vk-${name}.png`});
  } catch(e) {results.push({browser:name,error:e.message});}
  finally {await browser?.close();}
}
server.close();
await writeFile('test-results/vk-probe.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
