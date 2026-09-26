import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const executable = resolve('release/Kuro-0.1.0-Windows-x64.exe');
const profile = resolve('.test-data/portable-profile');
const artifacts = resolve('.test-data/portable');
await mkdir(artifacts,{recursive:true});
const reservation=createServer();
await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const port=reservation.address().port;
await new Promise(resolve=>reservation.close(resolve));
const env={...process.env,KURO_USER_DATA:profile,KURO_SKIP_AUTO_CONNECT:'1'};
delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(executable,[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let launchOutput='';
let launchExitCode;
for(const stream of [child.stdout,child.stderr]) stream.on('data',data=>{launchOutput=(launchOutput+data.toString()).slice(-6000);});
let launchError;
let exited=false;
child.on('error',error=>{launchError=error;});
child.on('exit',code=>{exited=true;launchExitCode=code;});
let browser;
try {
  const deadline=Date.now()+60000;
  let ready=false;
  while(Date.now()<deadline) {
    if(launchError) throw launchError;
    try {
      const response=await fetch(`http://127.0.0.1:${port}/json/version`);
      if(response.ok){ready=true;break;}
    } catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.equal(ready,true,`portable executable must start an inspectable desktop window; exit=${launchExitCode}; ${launchOutput}`);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context=browser.contexts()[0];
  const page=context.pages()[0] || await context.waitForEvent('page');
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.waitForSelector('.app-shell');
  assert.equal(await page.title(),'库洛 · OpenClaw 工作台');
  assert.equal(await page.evaluate(()=>typeof window.kuro.connect),'function');
  for (const name of ['listSkills','listModels','getModelSettings','saveModelSettings','switchSessionModel','listPlugins','installPlugin','choosePluginSource','restartPluginGateway']) {
    assert.equal(await page.evaluate(name=>typeof window.kuro[name],name),'function',`${name} must be exposed in the packaged bridge`);
  }
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  assert.equal(await page.locator('.hero-art img').evaluate(image=>image.complete && image.naturalWidth>0),true);
  if (await page.getByRole('button',{name:'展开角色'}).count()) await page.getByRole('button',{name:'展开角色'}).click();
  await page.waitForSelector('[data-live2d-state="ready"]',{timeout:20000});
  assert.equal(await page.locator('.live2d-stage canvas').count(),1);
  await page.screenshot({path:resolve(artifacts,'welcome.png')});
  for (const label of ['Skills','模型','插件']) {
    await page.getByRole('button',{name:label,exact:true}).click();
    await page.locator('.management-content').waitFor();
    assert.equal(await page.getByText('尚未连接 OpenClaw',{exact:true}).count(),1);
  }
  await page.screenshot({path:resolve(artifacts,'plugins.png')});
  assert.deepEqual(errors,[]);
  console.log('Portable EXE launch passed: title, local artwork, secure bridge, workspace and Live2D model.');
} finally {
  if(browser) {
    // Closing Electron can end its debug transport before CDP acknowledges the call.
    // Bound cleanup so the test does not wait on an acknowledgment from an exited app.
    await Promise.race([
      (async()=>{try { const session=await browser.newBrowserCDPSession(); await session.send('Browser.close'); } catch {}})(),
      new Promise(resolve=>setTimeout(resolve,1500)),
    ]);
    await Promise.race([browser.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1500))]);
  }
  if(!exited) {
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);
    if(!exited) child.kill();
  }
}
