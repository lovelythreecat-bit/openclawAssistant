import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
const require = createRequire(import.meta.url);
const live = process.argv.includes('--live');
const packaged = process.argv.includes('--packaged');
const executablePath = packaged ? resolve('release/win-unpacked/Kuro.exe') : require('electron');
const launchArgs = packaged ? [] : [resolve('.')];
const profile = resolve('.test-data', live ? 'live-profile' : `smoke-${Date.now()}`);
const artifacts = resolve('.test-data',live ? 'live' : 'desktop');
await mkdir(artifacts,{recursive:true});
const errors = [];
let server;
let application;
const abortRequests = [];
const managementWrites = [];
try {
  if (!live) {
    server = new WebSocketServer({port:0,host:'127.0.0.1'});
    await new Promise(resolve => server.once('listening',resolve));
    let history=[];
    let active;
    server.on('connection',socket => {
      const emit = (event,payload) => socket.send(JSON.stringify({type:'event',event,payload}));
      emit('connect.challenge',{nonce:'desktop-fixture-challenge',ts:Date.now()});
      socket.on('message',raw => {
        const request=JSON.parse(raw.toString());
        const respond=value=>socket.send(JSON.stringify({type:'res',id:request.id,ok:true,payload:value}));
        if(request.method==='connect') respond({type:'hello-ok',protocol:3,server:{version:'fixture-1'},features:{methods:['chat.send','chat.history','sessions.list','chat.abort'],events:['chat']},snapshot:{},auth:{deviceToken:request.params.scopes.includes('operator.admin')?'fixture-admin-device-token':'fixture-read-device-token',scopes:request.params.scopes},policy:{tickIntervalMs:60000,maxPayload:1048576,maxBufferedBytes:2097152}});
        else if(request.method==='sessions.list') respond({sessions:history.length?[{key:active?.sessionKey || 'agent:main:test',derivedTitle:'测试会话',updatedAt:Date.now()}]:[]});
        else if(request.method==='chat.history') respond({messages:history,sessionKey:request.params.sessionKey});
        else if(request.method==='skills.status') respond({skills:[{name:'fixture-skill',description:'桌面接口验收',source:'workspace',eligible:true,disabled:false,missing:{bins:[],env:[],config:[],os:[]}}]});
        else if(request.method==='models.list') respond({models:[{id:'model-a',name:'Fixture model',provider:'fixture'}]});
        else if(request.method==='config.get') respond({valid:true,hash:'fixture-config-hash',config:{agents:{defaults:{model:{primary:'fixture/model-a'}}},models:{providers:{fixture:{baseUrl:'https://example.org/v1',api:'openai-completions',apiKey:'__OPENCLAW_REDACTED__',models:[{id:'model-a',name:'Fixture model'}]}}}}});
        else if(request.method==='sessions.patch') { managementWrites.push(request); respond({ok:true,key:request.params.key,entry:{},resolved:{}}); }
        else if(request.method==='config.patch') { managementWrites.push(request); respond({ok:true}); }
        else if(request.method==='chat.send') {
          const {message,sessionKey,idempotencyKey}=request.params;
          assert.equal(request.params.deliver,false);
          history.push({role:'user',content:message});
          active={sessionKey,runId:idempotencyKey};
          respond({runId:idempotencyKey,status:'started'});
          if(message==='请慢慢回复') {
            emit('chat',{...active,seq:1,state:'delta',message:{role:'assistant',content:'正在慢慢回复'}});
          } else {
            emit('chat',{...active,seq:1,state:'delta',message:{role:'assistant',content:'你好，'}});
            emit('chat',{...active,seq:2,state:'delta',message:{role:'assistant',content:'你好，我是库洛。'}});
            setTimeout(()=>{
              const result={role:'assistant',content:'你好，我是库洛。\n\n```js\nconsole.log("hello");\n```'};
              history.push(result);
              // The real gateway flushes buffered text and emits final with the same seq.
              emit('chat',{...active,seq:3,state:'delta',message:result});
              emit('chat',{...active,seq:3,state:'final',message:result});
            },80);
          }
        } else if(request.method==='chat.abort') {
          abortRequests.push(request.params);
          // Match the real gateway's missing-ID response. Session fallback must
          // still stop the reply even when no terminal event is delivered.
          if (request.params.runId) respond({ok:true,aborted:false,runIds:[]});
          else respond({ok:true,aborted:true,runIds:['actual-active-run']});
        } else respond({});
      });
    });
  }
  const env={...process.env,KURO_USER_DATA:profile,KURO_SKIP_AUTO_CONNECT:live?'0':'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  application=await electron.launch({executablePath,args:launchArgs,env,timeout:30000});
  const page=await application.firstWindow();
  page.on('pageerror',error=>errors.push(error.message));
  await page.waitForSelector('.app-shell');
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  assert.equal(await page.evaluate(()=>typeof window.kuro.send),'function');
  if(live) {
    await page.waitForFunction(async()=>['connected','error'].includes((await window.kuro.getStatus()).state),{},{timeout:30000});
    const status=await page.evaluate(()=>window.kuro.getStatus());
    console.log('Live status:',JSON.stringify(status));
    if(status.state!=='connected') throw new Error(status.message || 'Live gateway not connected');
    const summary=await page.evaluate(async()=>{
      const sessions=await window.kuro.listSessions();
      let historyCount=0;
      if(sessions.length) historyCount=(await window.kuro.history(sessions[0].key)).messages.length;
      const settings=await window.kuro.getSettings();
      const skills=await window.kuro.listSkills();
      const models=await window.kuro.listModels();
      const modelSettings=await window.kuro.getModelSettings();
      return {sessions:sessions.length,historyCount,settingsKeys:Object.keys(settings),skills:skills.length,models:models.length,configuredProviders:modelSettings.providers.length};
    });
    console.log('Read-only gateway verification:',JSON.stringify(summary));
    await page.screenshot({path:resolve(artifacts,'welcome.png')});
    await page.getByRole('button',{name:'网关',exact:true}).click();
    await page.screenshot({path:resolve(artifacts,'gateway.png')});
    await page.getByRole('button',{name:'Skills',exact:true}).click();
    await page.waitForSelector('.management-item');
    await page.screenshot({path:resolve(artifacts,'skills.png')});
    await page.getByRole('button',{name:'模型',exact:true}).click();
    await page.getByLabel('默认模型 ID').waitFor();
    await page.screenshot({path:resolve(artifacts,'models.png')});
  } else {
    await page.screenshot({path:resolve(artifacts,'welcome.png')});
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,680));
    await page.waitForFunction(()=>innerWidth<=960);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({path:resolve(artifacts,'welcome-small.png')});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    assert.equal(overflow,false,'minimum window must not horizontally overflow');
    const composerVisible=await page.getByRole('button',{name:'发送消息',exact:true}).evaluate(button=>button.getBoundingClientRect().bottom<=innerHeight);
    assert.equal(composerVisible,true,'minimum window must keep the send control visible');
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1320,860));
    const port=server.address().port;
    await page.evaluate(async port=>{
      await window.kuro.saveSettings({url:`ws://127.0.0.1:${port}/`,distro:'Ubuntu-24.04',token:'fixture-private-token'});
      await window.kuro.connect();
    },port);
    await page.waitForFunction(async()=>(await window.kuro.getStatus()).state==='connected');
    await page.getByRole('button',{name:'Skills',exact:true}).click();
    await page.getByRole('heading',{name:'fixture-skill'}).waitFor();
    await page.getByRole('button',{name:'模型',exact:true}).click();
    await page.getByLabel('模型',{exact:true}).selectOption('fixture/model-a');
    await page.getByRole('button',{name:'应用到对话'}).click();
    await page.waitForFunction(()=>document.querySelector('.management-success')?.textContent.includes('已保存'));
    assert.equal(managementWrites.at(-1).method,'sessions.patch');
    assert.equal(managementWrites.at(-1).params.model,'fixture/model-a');
    const sealed=await readFile(resolve(profile,'connection.sealed'));
    const storedManagementToken=await application.evaluate(({safeStorage},base64)=>JSON.parse(safeStorage.decryptString(Buffer.from(base64,'base64'))).deviceToken==='fixture-admin-device-token',sealed.toString('base64'));
    assert.equal(storedManagementToken,true,'management token rotation must survive reconnect/restart');
    const modelConfig=await page.evaluate(()=>window.kuro.getModelSettings());
    assert.equal(modelConfig.providers[0].hasApiKey,true);
    assert.equal(JSON.stringify(modelConfig).includes('__OPENCLAW_REDACTED__'),false);
    await page.getByRole('button',{name:'保存默认模型',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.management-success')?.textContent.includes('模型配置已保存'));
    assert.equal(managementWrites.at(-1).method,'config.patch');
    assert.equal(managementWrites.at(-1).params.baseHash,'fixture-config-hash');
    await page.getByRole('button',{name:'聊天',exact:true}).click();
    const composer=page.getByRole('textbox',{name:'发送给库洛的消息'});
    await composer.fill('你好');
    await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await page.waitForSelector('.markdown pre');
    await page.waitForFunction(()=>!document.querySelector('.stop-button'));
    assert.equal(await page.locator('article.message').count(),2);
    await page.screenshot({path:resolve(artifacts,'chat.png')});
    await composer.fill('请慢慢回复');
    await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await page.getByRole('button',{name:'停止回复',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.stop-button'));
    assert.equal(abortRequests.length,2,'Stop must recover from a missing run ID');
    assert.ok(abortRequests[0].runId);
    assert.deepEqual(abortRequests[1],{sessionKey:abortRequests[0].sessionKey});
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.screenshot({path:resolve(artifacts,'settings.png')});
    const publicSettings=await page.evaluate(()=>window.kuro.getSettings());
    assert.equal(JSON.stringify(publicSettings).includes('fixture-private-token'),false);
    const encrypted=await readFile(resolve(profile,'connection.sealed'));
    assert.equal(encrypted.includes(Buffer.from('fixture-private-token')),false);
    assert.equal(encrypted.includes(Buffer.from('PRIVATE KEY')),false);
    const validation=await page.evaluate(async()=>{
      try { await window.kuro.saveSettings({url:'ws://example.com',distro:'Ubuntu'}); return false; } catch { return true; }
    });
    assert.equal(validation,true);
    await page.evaluate(()=>window.kuro.disconnect());
    await page.getByRole('button',{name:'聊天',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled(),true);
    // Explicit credential-free config must survive restart without WSL autodiscovery.
    await page.evaluate(async port=>{
      await window.kuro.saveSettings({url:`ws://127.0.0.1:${port}/`,distro:'Kuro-Fixture-Not-Installed'});
    },port);
    await application.close();
    application=await electron.launch({executablePath,args:launchArgs,env:{...env,KURO_SKIP_AUTO_CONNECT:'0'},timeout:30000});
    const restarted=await application.firstWindow();
    restarted.on('pageerror',error=>errors.push(error.message));
    await restarted.waitForSelector('.app-shell');
    await restarted.waitForFunction(async()=>['connected','error'].includes((await window.kuro.getStatus()).state),{},{timeout:30000});
    const resumed=await restarted.evaluate(async()=>({status:await window.kuro.getStatus(),settings:await window.kuro.getSettings()}));
    assert.equal(resumed.status.state,'connected','restart must use explicitly saved credential-free gateway');
    assert.equal(resumed.settings.distro,'Kuro-Fixture-Not-Installed');
  }
  assert.deepEqual(errors,[]);
  console.log(`Electron ${packaged?'packaged':'source'} ${live?'live read-only':'fixture'} smoke passed; screenshots: ${artifacts}`);
} finally {
  await application?.close();
  if(server) { for(const socket of server.clients) socket.terminate(); await new Promise(resolve=>server.close(resolve)); }
}
