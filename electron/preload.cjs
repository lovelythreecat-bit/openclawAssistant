const { contextBridge, ipcRenderer } = require('electron');
const call = async (name, ...args) => {
  const result = await ipcRenderer.invoke(`kuro:${name}`, ...args);
  if (!result.ok) throw new Error(result.error || '操作失败，请重试。');
  return result.value;
};
const listen = (name, listener) => {
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(`kuro:${name}`, handler);
  return () => ipcRenderer.removeListener(`kuro:${name}`, handler);
};
contextBridge.exposeInMainWorld('kuro', {
  listSkills: () => call('listSkills'),
  listModels: () => call('listModels'),
  getModelSettings: () => call('getModelSettings'),
  saveModelSettings: input => call('saveModelSettings', input),
  switchSessionModel: input => call('switchSessionModel', input),
  listPlugins: () => call('listPlugins'),
  installPlugin: input => call('installPlugin', input),
  choosePluginSource: () => call('choosePluginSource'),
  restartPluginGateway: () => call('restartPluginGateway'),
  getSettings: () => call('getSettings'),
  saveSettings: input => call('saveSettings', input),
  importWsl: distro => call('importWsl', distro),
  getStatus: () => call('getStatus'),
  connect: () => call('connect'),
  disconnect: () => call('disconnect'),
  listSessions: () => call('listSessions'),
  history: key => call('history', key),
  send: input => call('send', input),
  abort: input => call('abort', input),
  openExternal: url => call('openExternal', url),
  onStatus: listener => listen('status', listener),
  onEvent: listener => listen('event', listener),
});
