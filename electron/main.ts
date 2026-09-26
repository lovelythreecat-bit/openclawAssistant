import { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, type IpcMainInvokeEvent } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GatewayClient } from './gateway.js';
import { createIdentity } from './identity.js';
import { SettingsStore } from './store.js';
import { readWslGateway } from './wsl.js';
import { validateSessionKey, validateSettings } from './settings.js';
import { listSkills } from './skills.js';
import { createModelManager } from './models.js';
import { createPluginManager } from './plugins.js';
import type { SaveModelSettingsInput } from '../src/management-types.js';
import type { ConnectionStatus, HistoryResult, Session, SettingsInput } from '../src/types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
if (process.env.KURO_USER_DATA) app.setPath('userData', process.env.KURO_USER_DATA);
app.setName('库洛');
app.setAppUserModelId('local.kuro.openclaw');
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let window: BrowserWindow | null = null;
let store: SettingsStore;
const gateway = new GatewayClient();
const managementGateway = new GatewayClient(30_000);
const models = createModelManager(async <T = unknown>(method: string, params: unknown): Promise<T> => {
  if (method === 'models.list' || method === 'config.get') return gateway.request<T>(method, params);
  if (gateway.getStatus().state !== 'connected') throw new Error('请先连接 OpenClaw 网关。');
  if (managementGateway.getStatus().state !== 'connected') {
    await managementGateway.connect({ ...store.getConnection(), management: true });
  }
  return managementGateway.request<T>(method, params);
});
const plugins = createPluginManager(() => store.getPublicSettings());
let settingsBusy = false;
let startupError: string | undefined;
const entryURL = pathToFileURL(join(root, 'dist/index.html')).href;

function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : '操作失败，请重试。';
  if (store) {
    const {token,password,deviceToken} = store.getConnection();
    for (const secret of [token,password,deviceToken]) if (secret) message = message.split(secret).join('[已隐藏]');
  }
  return message.slice(0, 1500);
}
function send(channel: string, value: unknown) {
  if (window && !window.isDestroyed()) window.webContents.send(channel,value);
}
function currentStatus(): ConnectionStatus {
  if (startupError && gateway.getStatus().state !== 'connected') {
    return {state:'error',endpoint:store?.getPublicSettings().url || 'ws://127.0.0.1:18789/',message:startupError};
  }
  const status = gateway.getStatus();
  return {...status,endpoint:status.endpoint || store?.getPublicSettings().url || 'ws://127.0.0.1:18789/'};
}
gateway.on('status', (status: ConnectionStatus) => send('kuro:status',status));
gateway.on('event', event => send('kuro:event',event));
function persistDeviceToken({token,scopes}: {token:string;scopes:string[]}) {
  try { store.saveDeviceToken(token,scopes); }
  catch (error) { startupError = safeError(error); send('kuro:status', currentStatus()); }
}
gateway.on('deviceToken', persistDeviceToken);
managementGateway.on('deviceToken', persistDeviceToken);

function trusted(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame?.url !== entryURL) throw new Error('拒绝未知页面请求。');
}
function handle(name: string, operation: (...args: any[]) => unknown) {
  ipcMain.handle(`kuro:${name}`, async (event,...args) => {
    try { trusted(event); return {ok:true,value:await operation(...args)}; }
    catch (error) { return {ok:false,error:safeError(error)}; }
  });
}
async function exclusiveSettings<T>(action: () => Promise<T>): Promise<T> {
  if (settingsBusy) throw new Error('连接配置正在更新，请稍候。');
  settingsBusy = true;
  try { return await action(); } finally { settingsBusy = false; }
}
function connect() {
  return exclusiveSettings(async () => {
    startupError = undefined;
    return gateway.connect(store.getConnection());
  });
}

function registerIPC() {
  handle('listSkills', () => listSkills((method, params) => gateway.request(method, params)));
  handle('listModels', () => models.listModels());
  handle('getModelSettings', () => exclusiveSettings(() => models.getModelSettings()));
  handle('saveModelSettings', (input: SaveModelSettingsInput) => exclusiveSettings(() => models.saveModelSettings(input)));
  handle('switchSessionModel', (input: {sessionKey: string; model: string | null}) => exclusiveSettings(() => models.switchSessionModel(input)));
  handle('listPlugins', () => exclusiveSettings(() => plugins.listPlugins()));
  handle('installPlugin', (input: {source: string}) => exclusiveSettings(() => plugins.installPlugin(input)));
  handle('restartPluginGateway', () => exclusiveSettings(async () => {
    const result = await plugins.restartGateway();
    managementGateway.disconnect();
    gateway.disconnect();
    return result;
  }));
  handle('choosePluginSource', async () => {
    if (!window) return null;
    const choice = await dialog.showMessageBox(window, {
      type: 'question', title: '导入本地插件', message: '选择插件来源',
      buttons: ['压缩包', '插件目录', '取消'], defaultId: 0, cancelId: 2,
    });
    if (choice.response === 2) return null;
    const selected = await dialog.showOpenDialog(window, {
      title: choice.response === 0 ? '选择插件压缩包' : '选择插件目录',
      properties: [choice.response === 0 ? 'openFile' : 'openDirectory'],
      ...(choice.response === 0 ? { filters: [{name:'插件压缩包',extensions:['zip','tgz','gz','tar']}] } : {}),
    });
    return selected.canceled ? null : selected.filePaths[0] || null;
  });
  handle('getSettings', () => store.getPublicSettings());
  handle('getStatus', () => currentStatus());
  handle('saveSettings', (input: SettingsInput) => exclusiveSettings(async () => {
    validateSettings(input);
    managementGateway.disconnect();
    gateway.disconnect();
    startupError = undefined;
    return store.save(input);
  }));
  handle('importWsl', (distro: string) => exclusiveSettings(async () => {
    const config = await readWslGateway(distro);
    managementGateway.disconnect();
    gateway.disconnect();
    startupError = undefined;
    return store.importWsl(config);
  }));
  handle('connect', connect);
  handle('disconnect', () => { startupError = undefined; managementGateway.disconnect(); gateway.disconnect(); });
  handle('listSessions', async () => {
    const result = await gateway.request<{sessions:Session[]}>('sessions.list', {limit:100,includeDerivedTitles:true,includeLastMessage:true});
    if (!Array.isArray(result.sessions)) throw new Error('网关返回的会话列表格式不受支持。');
    return result.sessions;
  });
  handle('history', async (sessionKey: string) => {
    const result = await gateway.request<HistoryResult>('chat.history', {sessionKey:validateSessionKey(sessionKey),limit:200});
    if (!Array.isArray(result.messages)) throw new Error('网关返回的聊天历史格式不受支持。');
    return result;
  });
  handle('send', (input: {sessionKey:string;message:string;idempotencyKey:string}) => {
    if (!input || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 100000) throw new Error('消息不能为空，且不能超过 100,000 个字符。');
    if (typeof input.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new Error('消息请求标识不正确。');
    return gateway.request('chat.send',{sessionKey:validateSessionKey(input.sessionKey),message:input.message,idempotencyKey:input.idempotencyKey,deliver:false});
  });
  handle('abort', (input: {sessionKey:string;runId?:string}) => {
    const sessionKey = validateSessionKey(input?.sessionKey);
    if (input.runId !== undefined && (typeof input.runId !== 'string' || !input.runId || input.runId.length > 200)) throw new Error('运行标识不正确。');
    return gateway.request('chat.abort', {sessionKey,...(input.runId ? {runId:input.runId} : {})});
  });
  handle('openExternal', async (value: string) => {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('链接格式不正确。');
    const url = new URL(value);
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('仅允许打开 HTTP 或 HTTPS 链接。');
    await shell.openExternal(url.href);
  });
}

function createWindow() {
  window = new BrowserWindow({
    width:1320,height:860,minWidth:960,minHeight:680,title:'库洛 · OpenClaw 工作台',
    backgroundColor:'#fff8fb',show:false,autoHideMenuBar:true,
    icon:join(root,'assets/concepts/mascot-welcome-v1.png'),
    webPreferences:{preload:join(root,'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true},
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback) => callback(false));
  window.on('ready-to-show', () => window?.show());
  window.on('closed', () => {window = null;});
  void window.loadURL(entryURL);
}

app.on('second-instance', () => { if (window) { if(window.isMinimized()) window.restore(); window.show(); window.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { managementGateway.disconnect(); gateway.disconnect(); });
if (locked) void app.whenReady().then(async () => {
  try {
    store = new SettingsStore(app.getPath('userData'),safeStorage,createIdentity);
    registerIPC();
    createWindow();
    if (process.env.KURO_SKIP_AUTO_CONNECT !== '1') {
      try {
        await exclusiveSettings(async () => {
          if (store.needsInitialDiscovery()) {
            store.importWsl(await readWslGateway(store.getPublicSettings().distro));
            send('kuro:status',{state:'disconnected',endpoint:store.getPublicSettings().url,message:'已读取本机 WSL 网关配置。'});
          }
        });
        await connect();
      } catch (error) {
        startupError = safeError(error);
        send('kuro:status',currentStatus());
      }
    }
  } catch(error) {
    dialog.showErrorBox('库洛启动失败',safeError(error));
    app.quit();
  }
});
