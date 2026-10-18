// Run against a local server with the public sample: BASE=http://127.0.0.1:8080 node web/checks/export-job-checks.mjs
// Correctness regressions only; timing is deliberately excluded from characterization.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
const base=process.env.BASE ?? 'http://127.0.0.1:8080',out=process.env.CHECK_OUT ?? '/tmp/export-job-checks',results=[];
mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM ?? '/usr/bin/chromium',args:['--enable-unsafe-swiftshader']});
const demo=await fetch(`${base}/api/demo-shares`).then(r=>r.json());
const link=demo.shares.find(s=>!s.passcodeHint).shlinkUri;
const payload=JSON.parse(Buffer.from(link.split('shlink:/')[1],'base64url').toString());
payload.url=base+new URL(payload.url).pathname;
const url=`${base}/view#shlink:/${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
const must=(x,message)=>{if(!x)throw Error(message);};
async function one(name,fn){
 if(process.env.CHECK_CASE && process.env.CHECK_CASE!==name)return;
 const context=await browser.newContext({viewport:{width:1440,height:900},acceptDownloads:true});
 await context.addInitScript(()=>{delete window.showSaveFilePicker;});
 const page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 const cdp=await context.newCDPSession(page);
 await cdp.send('Network.enable');
 await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:80,downloadThroughput:1012500,uploadThroughput:168750});
 const result={name};
 try{
  await page.goto(url,{waitUntil:'commit'});
  await page.waitForSelector('#screen-overview:not(.hidden)',{timeout:60000});
  await fn(page,result);
  must(!errors.length,errors.join('\n'));
  result.success=true;
 }catch(e){result.success=false;result.error=String(e.stack??e);}
 result.errors=errors;
 await page.screenshot({path:`${out}/${name}.png`});
 results.push(result);writeFileSync(`${out}/results.json`,JSON.stringify(results,null,2)+'\n');
 console.log(JSON.stringify(result));await context.close();
}
async function ct(page){
 await page.locator('.study-open').filter({has:page.locator('.study-title',{hasText:/ABDOMEN/i})}).click();
 await page.waitForFunction(()=>window.__viewHooks.current().onScreen?.uid && window.__viewHooks.state().sliceCount===93,null,{timeout:60000});
}
async function start(page,plane='coronal'){
 return await page.evaluate(p=>{window.__racePending=window.__viewHooks.enterMpr(p);return {started:performance.now(),hadMpr:!!window.__viewHooks.current().mpr};},plane);
}
async function finish(page){await page.evaluate(()=>window.__racePending);}
await one('acquired-during-volume',async(page,r)=>{
 await ct(page);r.started=await start(page);
 must(!r.started.hadMpr,'volume was already complete before race');
 await page.selectOption('#view-plane','');await finish(page);
 r.final=await page.evaluate(()=>({current:window.__viewHooks.current(),plane:document.querySelector('#view-plane').value,hud:document.querySelector('#hud-tl').textContent}));
 must(!r.final.current.mpr&&r.final.plane===''&&!r.final.hud.includes('Reformatted'),'obsolete MPR replaced acquired');
});
await one('overview-during-volume',async(page,r)=>{
 await ct(page);r.started=await start(page);must(!r.started.hadMpr,'volume already ready');
 await page.click('#btn-back');
 r.afterBack=await page.evaluate(()=>({draws:window.__view.drawLog.length,at:performance.now()}));
 await finish(page);await page.waitForTimeout(250);
 r.final=await page.evaluate(()=>({current:window.__viewHooks.current(),draws:window.__view.drawLog.length,overview:!document.querySelector('#screen-overview').classList.contains('hidden')}));
 must(r.final.overview&&!r.final.current.mpr&&r.final.draws===r.afterBack.draws,'old volume drew after overview');
});
await one('new-plane-during-volume',async(page,r)=>{
 await ct(page);r.started=await start(page);must(!r.started.hadMpr,'volume already ready');
 await page.selectOption('#view-plane','sagittal');await finish(page);
 await page.waitForFunction(()=>window.__viewHooks.current().mpr==='sagittal',null,{timeout:90000});
 r.final=await page.evaluate(()=>window.__viewHooks.current());
 must(r.final.mpr==='sagittal','newer plane lost');
});
await one('other-series-during-volume',async(page,r)=>{
 await ct(page);r.started=await start(page);must(!r.started.hadMpr,'volume already ready');
 await page.locator('.series-btn',{hasText:'LUNG WINDOWS'}).click();
 await page.waitForFunction(()=>document.querySelector('#hud-tl').textContent.includes('LUNG WINDOWS')&&window.__viewHooks.current().onScreen?.uid,null,{timeout:60000});
 r.newSeries=await page.evaluate(()=>window.__viewHooks.current().series);
 await page.evaluate(()=>{window.__raceNew=window.__viewHooks.enterMpr('coronal');});
 await page.evaluate(()=>Promise.all([window.__racePending,window.__raceNew]));
 await page.locator('#slice').fill('3');
 r.final=await page.evaluate(()=>({current:window.__viewHooks.current(),hud:document.querySelector('#hud-tl').textContent}));
 must(r.final.current.series===r.newSeries&&r.final.current.mpr==='coronal'&&r.final.hud.includes('LUNG WINDOWS'),'old series displaced newer volume');
});
await one('download-close-reopen-cancel',async(page,r)=>{
 const card=page.locator('.study-card').filter({has:page.locator('.study-title',{hasText:/BRAIN/i})});
 await card.locator('.study-actions button',{hasText:'Download study'}).click();
 await page.locator('#sheet-download [data-choice="study"]').click();
 await page.waitForTimeout(300);
 await page.locator('#sheet-download [data-close]').click();
 must(await page.locator('#sheet-download').evaluate(x=>x.classList.contains('hidden')),'progress did not close');
 await page.locator('.download-job-open').first().click();
 r.reopened=await page.locator('#dl-status').textContent();
 await page.locator('#btn-dl-cancel').click();
 await page.waitForFunction(()=>/cancel/i.test(document.querySelector('#dl-status').textContent),null,{timeout:10000});
 r.final=await page.locator('#dl-status').textContent();
 must(/cancel/i.test(r.final),'cancellation not shown');
});

await one('study-export-browse-resume-complete',async(page,r)=>{
 const download=page.waitForEvent('download',{timeout:120000});
 const card=page.locator('.study-card').filter({has:page.locator('.study-title',{hasText:/BRAIN/i})});
 await card.locator('.study-actions button',{hasText:'Download study'}).click();
 await page.locator('#sheet-download [data-choice="study"]').click();
 await page.waitForFunction(()=>window.__viewHooks.exportState().jobs[0]?.progress.files>0);
 await ct(page);
 r.browsing=await page.evaluate(()=>({state:window.__viewHooks.exportState(),hidden:document.querySelector('#sheet-download').classList.contains('hidden'),current:window.__viewHooks.current()}));
 must(r.browsing.hidden&&r.browsing.state.foreground.kind==='browse','direct navigation did not dismiss progress and release preference');
 must(!['completed','failed','cancelled'].includes(r.browsing.state.jobs[0].phase),'download was already terminal before browsing');
 await page.evaluate(()=>window.__viewHooks.showSlice(92));
 await page.locator('.download-job-open').first().click();
 r.resumed=await page.evaluate(()=>window.__viewHooks.exportState());
 must(r.resumed.foreground.jobId===r.resumed.jobs[0].id,'return to progress did not focus the study job');
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:`${out}/phone-running-study-export.png`});
 const saved=await download;await saved.saveAs(`${out}/study.zip`);
 must(await saved.failure()===null,'study archive download failed');
 await page.waitForFunction(()=>window.__viewHooks.exportState().jobs[0].cleanupComplete);
 await page.waitForFunction(()=>window.__view.drawLog.at(-1)?.[1]===92&&window.__viewHooks.current().onScreen?.uid,null,{timeout:60000});
 r.final=await page.evaluate(()=>({state:window.__viewHooks.exportState(),current:window.__viewHooks.current(),lastDraw:window.__view.drawLog.at(-1)}));
 must(r.final.state.jobs[0].phase==='completed'&&r.final.state.foreground.kind==='browse','resumed study completion did not release preference');
 must(r.final.current.desired.slice===92&&r.final.lastDraw[1]===92,'held CT image did not finish after export');
 r.archive={filename:saved.suggestedFilename(),path:`${out}/study.zip`};
});

async function oneImage(page) {
 await page.click('#btn-download-menu');
 await page.locator('#sheet-download [data-choice="image"]').click();
}
async function heldWriters(page) {
 await page.evaluate(()=>{
  window.__writers=[];
  window.showSaveFilePicker=async()=>({createWritable:async()=>{
   const record={bytes:0,aborted:false};window.__writers.push(record);
   return {write:async c=>{record.bytes+=c.byteLength;},close:()=>new Promise((resolve,reject)=>{record.finish=resolve;record.reject=reject;}),abort:async()=>{record.aborted=true;record.reject?.(new DOMException('cancelled','AbortError'));}};
  }});
 });
}
await one('resumed-job-old-completion',async(page,r)=>{
 await ct(page);await heldWriters(page);await oneImage(page);
 await page.waitForFunction(()=>window.__writers[0]?.finish,null,{timeout:30000});
 const first=await page.evaluate(()=>window.__viewHooks.exportState().jobs[0].id);
 await page.locator('#sheet-download [data-close]').click();
 await page.locator('.download-job-open').first().click();
 r.resumed=await page.evaluate(()=>window.__viewHooks.exportState());
 must(r.resumed.foreground.jobId===first,'resume did not focus A');
 await page.evaluate(()=>window.__writers[0].finish());
 await page.waitForFunction(()=>window.__viewHooks.exportState().jobs[0].phase==='completed');
 r.final=await page.evaluate(()=>window.__viewHooks.exportState());
 must(r.final.foreground.kind==='browse','actual A completion did not release resumed A');
});
await one('two-jobs-late-completion',async(page,r)=>{
 await ct(page);await heldWriters(page);await oneImage(page);
 await page.waitForFunction(()=>window.__writers[0]?.finish,null,{timeout:30000});
 await oneImage(page);
 await page.waitForFunction(()=>window.__writers[1]?.finish,null,{timeout:30000});
 r.before=await page.evaluate(()=>window.__viewHooks.exportState());
 must(r.before.jobs.length===2,'second job was not created');
 await page.evaluate(()=>window.__writers[0].finish());
 await page.waitForFunction(()=>window.__viewHooks.exportState().jobs[0].phase==='completed');
 r.afterA=await page.evaluate(()=>window.__viewHooks.exportState());
 must(r.afterA.foreground.jobId===r.before.jobs[1].id,'late A completion changed B focus');
 must(await page.locator('#btn-dl-cancel').isVisible(),'late A hid B cancel control');
 await page.click('#btn-dl-cancel');
 await page.waitForFunction(()=>window.__viewHooks.exportState().jobs[1].cleanupComplete);
 r.final=await page.evaluate(()=>({state:window.__viewHooks.exportState(),writers:window.__writers.map(w=>({bytes:w.bytes,aborted:w.aborted}))}));
 must(r.final.state.jobs[1].phase==='cancelled'&&r.final.writers[1].aborted,'B cancel did not settle its writer');
 must(!r.final.writers[0].aborted,'B cancellation aborted completed A');
});
await one('cancel-during-save-picker',async(page,r)=>{
 await ct(page);
 await page.evaluate(()=>{
  window.__picker={writes:0,aborts:0};
  window.showSaveFilePicker=()=>new Promise(resolve=>{window.__picker.finish=()=>resolve({createWritable:async()=>({write:async()=>window.__picker.writes++,close:async()=>{},abort:async()=>window.__picker.aborts++})});});
 });
 await oneImage(page);
 await page.click('#btn-dl-cancel');
 await page.locator('#sheet-download [data-close]').click();
 await page.evaluate(()=>window.__picker.finish());
 await page.waitForFunction(()=>window.__viewHooks.exportState().jobs[0].cleanupComplete);
 r.final=await page.evaluate(()=>({state:window.__viewHooks.exportState(),picker:{writes:window.__picker.writes,aborts:window.__picker.aborts}}));
 must(r.final.state.jobs[0].phase==='cancelled'&&r.final.picker.writes===0&&r.final.picker.aborts===1,'cancelled planning later wrote output');
 must(r.final.state.foreground.kind==='browse','cancelled planning stole focus');
});
for (const failure of ['write','close']) await one(`sink-${failure}-failure`,async(page,r)=>{
 await ct(page);
 await page.evaluate(failure=>{
  window.__sinkAborts=0;
  window.showSaveFilePicker=async()=>({createWritable:async()=>({write:async()=>{if(failure==='write')throw Error('injected write failure');},close:async()=>{if(failure==='close')throw Error('injected close failure');},abort:async()=>{window.__sinkAborts++;}})});
 },failure);
 await oneImage(page);
 await page.waitForFunction(()=>window.__viewHooks.exportState().jobs[0].cleanupComplete);
 r.failed=await page.evaluate(()=>({state:window.__viewHooks.exportState(),aborts:window.__sinkAborts}));
 must(r.failed.state.jobs[0].phase==='failed'&&r.failed.state.foreground.kind==='browse'&&r.failed.aborts===1,'sink failure did not release job exactly once');
 await page.locator('#sheet-download [data-close]').click();
 await page.click('#btn-back');
 await page.locator('.study-open').filter({has:page.locator('.study-title',{hasText:/BRAIN/i})}).click();
 await page.waitForFunction(()=>window.__viewHooks.current().onScreen?.uid&&window.__viewHooks.state().sliceCount===20,null,{timeout:60000});
 r.final=await page.evaluate(()=>window.__viewHooks.current());
 must(!!r.final.onScreen?.uid,'MRI did not browse after failure');
});
await browser.close();process.exitCode=results.every(x=>x.success)?0:1;

