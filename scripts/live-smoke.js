import {chromium} from 'playwright';
import {createApp} from '../server/index.js';
import {mkdir,writeFile} from 'node:fs/promises';
const app=await createApp({dataDir:null});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1366,height:768}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${app.server.address().port}`);
 await page.fill('#nickname','Проверка VK'); await page.click('#enter'); await page.waitForSelector('#room:not([hidden])');
 await page.fill('#video-url','https://vk.ru/video_ext.php?oid=-121898133&id=456247731&hash=01643e57e4a2f464');await page.click('#open-video');
 await page.waitForFunction(()=>document.querySelector('#player-notice').textContent.includes('не подтвердил'),null,{timeout:40000});
 await page.fill('#message','Чат работает при недоступном видео');await page.press('#message','Enter');await page.getByText('Чат работает при недоступном видео',{exact:true}).waitFor();
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/live-app.png',fullPage:true});
 const result={notice:await page.locator('#player-notice').textContent(),chatWorks:true,errors};
 await writeFile('test-results/live-app.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await browser.close();await app.close();}
