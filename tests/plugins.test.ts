import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPluginManager, type PluginExecutor } from '../electron/plugins.js';

const settings = () => ({distro:'Ubuntu-24.04',url:'ws://127.0.0.1:18789/'});
const inventory = {plugins:[{id:'calendar',name:'Calendar',description:'Events',enabled:true,status:'loaded',version:'1.2.0',apiKey:'never expose'}],diagnostics:[]};

test('plugin inventory accepts CLI logs surrounding JSON and exposes only public fields', async () => {
  const manager = createPluginManager(settings, async () => ({stdout:`startup log\n${JSON.stringify(inventory)}\nfinished`,stderr:''}));
  const result = await manager.listPlugins();
  assert.equal(result.plugins[0].id,'calendar');
  assert.equal(result.plugins[0].enabled,true);
  assert.equal(JSON.stringify(result).includes('never expose'),false);
});

test('plugin sources reject options, unsupported protocols and controls before executing', async () => {
  let calls = 0;
  const manager = createPluginManager(settings, async () => { calls++; return {stdout:'',stderr:''}; });
  for (const source of ['--force','git:owner/repo','https://example.com/plugin.zip','a\n--force','','@scope/pkg;echo bad']) {
    await assert.rejects(manager.installPlugin({source}), /来源/);
  }
  assert.equal(calls,0);
});

test('installation sends source as an isolated argument with fixed WSL executable and bounded execution', async () => {
  const calls: Parameters<PluginExecutor>[0][] = [];
  const manager = createPluginManager(settings, async call => { calls.push(call); return {stdout:'{"ok":true}',stderr:''}; });
  const result = await manager.installPlugin({source:'C:\\Users\\Test User\\plugin.zip'});
  assert.equal(result.restartRequired,true);
  assert.equal(calls[0].file,'wsl.exe');
  assert.deepEqual(calls[0].args.slice(0,7),['-d','Ubuntu-24.04','--','python3','-','install','18789']);
  assert.equal(calls[0].args.at(-1),'C:\\Users\\Test User\\plugin.zip');
  assert.equal(calls[0].windowsHide,true);
  assert.ok(calls[0].timeout <= 180000);
});

test('concurrent mutations are rejected and lock is released on failure without leaking process output', async () => {
  let reject!: (error: Error) => void;
  const manager = createPluginManager(settings, async () => new Promise((_resolve,no) => { reject = no; }));
  const pending = manager.installPlugin({source:'npm:@scope/calendar@1.2.0'});
  await assert.rejects(manager.restartGateway(), /正在/);
  reject(new Error('token=secret-value'));
  await assert.rejects(pending, error => error instanceof Error && !error.message.includes('secret-value'));
  const again = manager.restartGateway();
  reject(new Error('failed'));
  await assert.rejects(again, /失败/);
});

test('unbound gateway and malformed inventory fail closed', async () => {
  const manager = createPluginManager(settings, async () => ({stdout:'{"error":"ENVIRONMENT_MISMATCH"}',stderr:''}));
  await assert.rejects(manager.installPlugin({source:'clawhub:calendar'}), /网关/);
  await assert.rejects(createPluginManager(settings,async () => ({stdout:'{"plugins":"wrong"}',stderr:''})).listPlugins(), /列表/);
});

test('malformed plugin entries cannot disappear into an apparently valid empty inventory', async () => {
  for (const plugins of [[null],[{name:'Missing ID'}],[{id:12}],[{id:''}],[{id:'calendar',enabled:'yes'}]]) {
    const manager=createPluginManager(settings,async () => ({stdout:JSON.stringify({plugins}),stderr:''}));
    await assert.rejects(manager.listPlugins(), /列表/);
  }
});
