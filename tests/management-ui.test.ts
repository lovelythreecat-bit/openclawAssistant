import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import test, { before, after } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let browser: Browser;
let base: string;
before(async () => {
  server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 5196, strictPort: false } });
  await server.listen(); base = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1100, height: 740 }, bypassCSP: true });
  await page.addInitScript('globalThis.__name = value => value;');
  await page.addInitScript(() => {
    const listeners = new Set<(value: any) => void>();
    const f: any = {
      config: { url: 'ws://127.0.0.1:18789/', distro: 'Ubuntu-24.04', hasCredential: true, credentialSource: 'wsl' },
      status: { state: 'connected', endpoint: 'ws://127.0.0.1:18789/' },
      models: { hash: 'revision-one', defaultModel: 'demo/model-a', providers: [{ id: 'demo', api: 'openai-completions', baseUrl: 'https://api.example.org/v1', hasApiKey: true, models: [{id: 'model-a',name: 'Alpha'}] }] },
      emit(value: any) { f.status = value; listeners.forEach(fn => fn(value)); },
      saved: [], switched: [], installed: [], restarts: 0,
    };
    (window as any).fixture = f;
    (window as any).kuro = {
      getSettings: async () => f.config, getStatus: async () => f.status,
      onStatus: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); }, onEvent: () => () => {},
      listSessions: async () => [{key:'agent:main:main',displayName:'管理测试对话',model:'model-a',modelProvider:'demo'}],
      history: async () => ({messages:[]}), openExternal: async () => {},
      connect: async () => { f.emit({state:'connected',endpoint:f.config.url}); return f.status; },
      listSkills: async () => [{name:'日历助手',description:'管理日程',source:'workspace',eligible:true,disabled:false,missing:[]}, {name:'系统工具',description:'需要额外命令',source:'bundled',eligible:false,disabled:false,missing:['命令：uv']}],
      listModels: async () => [{id:'demo/model-a',name:'Alpha',provider:'demo'}, {id:'demo/model-b',name:'Beta',provider:'demo'}],
      getModelSettings: async () => f.models,
      switchSessionModel: async (input: any) => { f.switched.push(input); },
      saveModelSettings: async (input: any) => { f.saved.push(input); return {message:'配置已保存',restartRequired:true}; },
      listPlugins: async () => ({plugins:[{id:'calendar',name:'日历插件',description:'示例插件',enabled:true,status:'loaded',version:'1.0'}],diagnostics:[],environment:'WSL · Ubuntu-24.04'}),
      choosePluginSource: async () => 'C:\\Plugin Files\\calendar.zip',
      installPlugin: async (input: any) => { f.installed.push(input); return new Promise(resolve => { f.finishInstall = () => resolve({message:'插件已安装，重启网关后生效。',restartRequired:true}); }); },
      restartPluginGateway: async () => { f.restarts++; return {message:'网关已重启',restartRequired:false}; },
    };
  });
  await page.goto(base);
  await page.getByRole('button', { name: '管理测试对话', exact: false }).waitFor();
  return page;
}

test('Skills page filters actual status and keeps all navigation accessible at minimum window size', async () => {
  const page = await open();
  try {
    await page.setViewportSize({width:944,height:641});
    await page.getByRole('button',{name:'Skills',exact:true}).click();
    await page.getByRole('heading',{name:'日历助手'}).waitFor();
    assert.equal(await page.getByText('命令：uv',{exact:true}).count(),1);
    await page.getByLabel('Skill 状态筛选').selectOption('ready');
    assert.equal(await page.getByRole('heading',{name:'系统工具'}).count(),0);
    const searchBounds = await page.getByLabel('搜索 Skills').boundingBox();
    assert.ok(searchBounds && searchBounds.width >= 150, 'skill filter must leave a usable search field');
    const bounds = await page.locator('.rail-bottom').boundingBox();
    assert.ok(bounds && bounds.y + bounds.height <= 641, 'navigation footer must fit minimum content height');
    for (const label of ['聊天','Skills','模型','插件','网关','设置']) {
      const box = await page.getByRole('navigation').getByRole('button',{name:label,exact:true}).boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= 641, `${label} navigation should fit`);
    }
  } finally { await page.close(); }
});

test('model page applies selected session model and preserves a blank existing provider key', async () => {
  const page = await open();
  try {
    await page.getByRole('button',{name:'管理测试对话',exact:false}).click();
    await page.getByRole('button',{name:'模型',exact:true}).click();
    await page.getByLabel('模型',{exact:true}).selectOption('demo/model-b');
    await page.getByRole('button',{name:'应用到对话'}).click();
    await page.waitForFunction(() => (window as any).fixture.switched.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.switched[0]),{sessionKey:'agent:main:main',model:'demo/model-b'});
    await page.getByLabel('选择服务',{exact:true}).selectOption('demo');
    assert.equal(await page.getByLabel('API 密钥',{exact:false}).inputValue(),'');
    await page.getByLabel('模型 1 名称',{exact:true}).fill('Alpha Updated');
    await page.getByRole('button',{name:'保存服务配置',exact:true}).click();
    await page.waitForFunction(() => (window as any).fixture.saved.length === 1);
    const saved = await page.evaluate(() => (window as any).fixture.saved[0]);
    assert.equal(saved.hash,'revision-one');
    assert.equal('apiKey' in saved.provider,false);
    assert.equal(saved.provider.models[0].name,'Alpha Updated');
    assert.equal(await page.getByRole('button',{name:'重启并连接',exact:true}).count(),0);
  } finally { await page.close(); }
});

test('plugin import shows pending state, prevents duplicate installs and restarts only on click', async () => {
  const page = await open();
  try {
    await page.getByRole('button',{name:'插件',exact:true}).click();
    await page.getByRole('heading',{name:'日历插件'}).waitFor();
    await page.getByRole('button',{name:'选择本地插件'}).click();
    assert.equal(await page.getByLabel('插件来源').inputValue(),'C:\\Plugin Files\\calendar.zip');
    await page.getByRole('button',{name:'安装插件',exact:true}).click();
    await page.waitForFunction(() => (window as any).fixture.installed.length === 1);
    assert.equal(await page.getByRole('button',{name:'安装插件',exact:true}).isDisabled(),true);
    assert.equal(await page.evaluate(() => (window as any).fixture.restarts),0);
    await page.evaluate(() => (window as any).fixture.finishInstall());
    await page.getByRole('button',{name:'重启并连接'}).waitFor();
    await page.getByRole('button',{name:'重启并连接'}).click();
    await page.waitForFunction(() => (window as any).fixture.restarts === 1);
  } finally { await page.close(); }
});

test('changing the connected environment clears provider secrets and stale management results', async () => {
  const page = await open();
  try {
    await page.getByRole('button',{name:'模型',exact:true}).click();
    await page.getByLabel('选择服务').selectOption('demo');
    await page.getByLabel('API 密钥',{exact:false}).fill('sensitive-new-key');
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.config = {...f.config,url:'ws://127.0.0.1:19999/',distro:'Other'};
      f.emit({state:'connected',endpoint:f.config.url});
    });
    await page.waitForFunction(() => (document.querySelector('#provider-key') as HTMLInputElement)?.value === '');
    assert.equal(await page.getByLabel('选择服务').inputValue(),'');
    mkdirSync('.test-data/management', {recursive:true});
    await page.screenshot({path:'.test-data/management/models.png',fullPage:true});
    await page.getByRole('button',{name:'插件',exact:true}).click();
    await page.getByRole('heading',{name:'日历插件'}).waitFor();
    await page.screenshot({path:'.test-data/management/plugins.png',fullPage:true});
  } finally { await page.close(); }
});

test('failed reconnect keeps the model reload reminder instead of reporting completion', async () => {
  const page = await open();
  try {
    await page.getByRole('button',{name:'模型',exact:true}).click();
    await page.getByRole('button',{name:'保存默认模型',exact:true}).click();
    await page.getByText('配置已更新，网关正在重新加载',{exact:true}).waitFor();
    await page.evaluate(() => { window.kuro.connect = async () => { throw new Error('连接失败'); }; });
    await page.getByRole('button',{name:'重新连接',exact:true}).click();
    await page.locator('.management-error').waitFor({timeout:3000});
    assert.equal(await page.getByText('配置已更新，网关正在重新加载',{exact:true}).count(),1);
  } finally { await page.close(); }
});

test('plugin restart remains available after navigating away from the installation page', async () => {
  const page = await open();
  try {
    await page.getByRole('button',{name:'插件',exact:true}).click();
    await page.getByRole('heading',{name:'日历插件'}).waitFor();
    await page.getByRole('button',{name:'Skills',exact:true}).click();
    await page.getByRole('button',{name:'插件',exact:true}).click();
    await page.getByRole('heading',{name:'日历插件'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'重启网关',exact:true}).count(),1);
  } finally { await page.close(); }
});
