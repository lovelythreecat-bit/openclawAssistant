import { validateSessionKey } from './settings.js';
import { GatewayRequestError } from './gateway.js';
import type { ModelOption, ModelSettings, SaveModelSettingsInput, MutationResult } from '../src/management-types.js';

type GatewayRequest = <T = unknown>(method: string, params: unknown) => Promise<T>;
type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const APIS = new Set(['openai-completions', 'openai-responses', 'openai-codex-responses', 'anthropic-messages', 'google-generative-ai', 'github-copilot', 'bedrock-converse-stream', 'ollama']);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

function publicBaseUrl(value: unknown): string {
  try {
    const url = new URL(text(value));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

function identifier(value: unknown, label: string, provider = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\x00-\x20\x7f]/.test(value) || forbidden.has(value)
    || (provider && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value))) throw new Error(`${label}格式不正确。`);
  return value;
}
function publicFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : '';
  if (error instanceof GatewayRequestError && error.pairingRequestId) {
    return new Error(`OpenClaw 正在等待设备管理权限批准。请在运行该网关的环境中执行：openclaw devices approve ${error.pairingRequestId}。批准后返回此页重新保存；若请求已过期，请再次保存生成新请求。`);
  }
  if (/operator\.admin|missing scope|pairing required|requires pairing|scope upgrade pending approval/i.test(message)) return new Error('此操作需要 OpenClaw 管理权限。请在运行该网关的环境中执行 openclaw devices list，找到“库洛桌面”的待批准请求，再执行 openclaw devices approve <请求编号>。批准后重新保存。');
  if (/base hash|config changed|配置已变更/.test(message)) return new Error('配置已变更，请刷新后重试。');
  // Gateway errors may echo provider credentials or the submitted config body.
  return new Error('模型操作失败，请检查网关连接、模型配置和权限后重试。');
}

export function createModelManager(request: GatewayRequest) {
  async function readSnapshot() {
    let raw: unknown;
    try { raw = await request('config.get', {}); } catch (error) { throw publicFailure(error); }
    const snapshot = object(raw);
    if (snapshot.valid === false || !text(snapshot.hash) || !snapshot.config || Array.isArray(snapshot.config) || typeof snapshot.config !== 'object') throw new Error('网关模型配置无效，请先修复 OpenClaw 配置。');
    return { hash: snapshot.hash as string, config: object(snapshot.config) };
  }

  return {
    async listModels(): Promise<ModelOption[]> {
      let raw: unknown;
      try { raw = await request('models.list', {}); } catch (error) { throw publicFailure(error); }
      const models = object(raw).models;
      if (!Array.isArray(models)) throw new Error('网关返回的模型列表格式不受支持。');
      const seen = new Set<string>();
      return models.flatMap((value: unknown) => {
        const model = object(value);
        if (!text(model.id) || !text(model.provider)) return [];
        const id = model.id.startsWith(`${model.provider}/`) ? model.id : `${model.provider}/${model.id}`;
        if (seen.has(id)) return [];
        seen.add(id);
        return [{ id, name: text(model.name) || model.id, provider: model.provider }];
      });
    },

    async getModelSettings(): Promise<ModelSettings> {
      const { hash, config } = await readSnapshot();
      const model = object(object(config.agents).defaults).model;
      return {
        hash,
        defaultModel: typeof model === 'string' ? model : text(object(model).primary),
        providers: Object.entries(object(object(config.models).providers)).map(([id, value]) => {
          const provider = object(value);
          return { id, baseUrl: publicBaseUrl(provider.baseUrl), api: text(provider.api), hasApiKey: Boolean(provider.apiKey), models: Array.isArray(provider.models) ? provider.models.flatMap((entry: unknown) => {
            const model = object(entry);
            return text(model.id) ? [{ id: model.id, name: text(model.name) || model.id }] : [];
          }) : [] };
        }),
      };
    },

    async saveModelSettings(input: SaveModelSettingsInput): Promise<MutationResult> {
      if (!input || typeof input.hash !== 'string' || !input.hash || input.hash.length > 256) throw new Error('请先加载有效的模型配置。');
      if (input.defaultModel === undefined && input.provider === undefined) throw new Error('没有需要保存的模型配置。');
      if (input.defaultModel !== undefined) identifier(input.defaultModel, '默认模型');
      const provider = input.provider;
      const removals = new Set<string>();
      if (provider !== undefined) {
        if (!provider || typeof provider !== 'object') throw new Error('提供商配置格式不正确。');
        identifier(provider.id, '提供商', true);
        let url: URL;
        try { url = new URL(provider.baseUrl); } catch { throw new Error('模型 API 地址格式不正确。'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || provider.baseUrl.length > 4096) throw new Error('模型 API 地址必须是无凭据的 HTTP 或 HTTPS 地址。');
        if (!APIS.has(provider.api)) throw new Error('不支持此模型 API 类型。');
        if (provider.apiKey !== undefined && (typeof provider.apiKey !== 'string' || provider.apiKey.length > 16384 || /[\x00-\x1f\x7f]/.test(provider.apiKey))) throw new Error('模型 API Key 格式不正确。');
        if (provider.removeModelIds !== undefined) {
          if (!Array.isArray(provider.removeModelIds) || provider.removeModelIds.length > 300) throw new Error('待删除模型列表格式不正确。');
          for (const id of provider.removeModelIds) {
            identifier(id, '待删除模型');
            if (removals.has(id)) throw new Error('待删除模型 ID 重复。');
            removals.add(id);
          }
        }
        if (!Array.isArray(provider.models) || (!provider.models.length && !removals.size) || provider.models.length > 300) throw new Error('请填写 1 至 300 个模型，或指定待删除模型。');
        const seen = new Set<string>();
        for (const model of provider.models) {
          identifier(model?.id, '模型');
          if (removals.has(model.id)) throw new Error('不能同时更新和删除同一个模型。');
          if (typeof model.name !== 'string' || !model.name.trim() || model.name.length > 300 || /[\x00-\x1f\x7f]/.test(model.name) || seen.has(model.id)) throw new Error('模型名称无效或模型 ID 重复。');
          seen.add(model.id);
        }
      }
      const { hash, config } = await readSnapshot();
      if (hash !== input.hash) throw new Error('配置已变更，请刷新后重试。');
      const patch: ObjectValue = {};
      const defaults = object(object(config.agents).defaults);
      const allowlist = object(defaults.models);
      const additions: ObjectValue = {};
      if (input.defaultModel !== undefined) {
        patch.agents = { defaults: { model: { primary: input.defaultModel } } };
        if (Object.keys(allowlist).length && !Object.hasOwn(allowlist, input.defaultModel)) additions[input.defaultModel] = {};
      }
      if (provider) {
        const existing = object(object(object(config.models).providers)[provider.id]);
        const existingModels = Array.isArray(existing.models) ? existing.models : [];
        const currentDefault = typeof defaults.model === 'string' ? defaults.model : text(object(defaults.model).primary);
        for (const id of removals) {
          const canonical = `${provider.id}/${id}`;
          if (canonical === currentDefault || canonical === input.defaultModel) throw new Error('不能删除默认模型，请先更改并保存默认模型。');
          if (!existingModels.some((model: unknown) => object(model).id === id)) throw new Error('待删除模型在此提供商中不存在，请刷新后重试。');
        }
        // config.patch replaces arrays: send all survivors, including their metadata.
        const models = existingModels.filter((model: unknown) => !removals.has(object(model).id)).map((model: unknown) => ({ ...object(model) }));
        for (const model of provider.models) {
          const index = models.findIndex((entry: ObjectValue) => entry.id === model.id);
          if (index < 0) models.push({ id: model.id, name: model.name.trim() });
          else models[index] = { ...models[index], name: model.name.trim() };
          const canonical = `${provider.id}/${model.id}`;
          if (Object.keys(allowlist).length && !Object.hasOwn(allowlist, canonical)) additions[canonical] = {};
        }
        const providerPatch: ObjectValue = { baseUrl: provider.baseUrl.trim(), api: provider.api, models };
        if (provider.apiKey?.trim()) providerPatch.apiKey = provider.apiKey.trim();
        patch.models = { providers: { [provider.id]: providerPatch } };
      }
      if (Object.keys(additions).length) {
        patch.agents ??= { defaults: {} };
        patch.agents.defaults.models = additions;
      }
      try {
        const result = object(await request('config.patch', { baseHash: hash, raw: JSON.stringify(patch) }));
        if (result.ok !== true) throw new Error('Invalid config.patch response');
        return { message: result.noop ? '模型配置未发生变化。' : '模型配置已保存，网关可能短暂重连。', restartRequired: result.noop !== true };
      } catch (error) { throw publicFailure(error); }
    },

    async switchSessionModel(input: { sessionKey: string; model: string | null }): Promise<void> {
      const key = validateSessionKey(input?.sessionKey);
      if (input.model !== null) identifier(input.model, '模型');
      try {
        const result = object(await request('sessions.patch', { key, model: input.model }));
        if (result.ok !== true) throw new Error('Invalid sessions.patch response');
      } catch (error) { throw publicFailure(error); }
    },
  };
}
