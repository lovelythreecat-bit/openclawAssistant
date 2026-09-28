import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Boxes, Check, Download, FolderOpen, LoaderCircle, Plus, RefreshCw, Search, Settings2, Sparkles, Trash2, Undo2, WifiOff } from 'lucide-react';
import type { ModelOption, ModelProvider, ModelSettings, MutationResult, PluginList, SkillInfo } from './management-types';
import { errorText } from './useWorkspace';

export interface ManagementPageProps {
  page: 'skills' | 'models' | 'plugins';
  connected: boolean;
  connectionKey: string;
  sessionKey: string;
  sessionModel?: string;
  sessionBusy: boolean;
  onModelChanged: () => void;
  onReconnect: () => Promise<unknown>;
}

const pageCopy = {
  skills: { title: 'Skills', subtitle: '看看库洛已经掌握了哪些能力。', kicker: 'SKILL LIBRARY', icon: Sparkles },
  models: { title: '模型', subtitle: '为当前对话选择模型，也可以配置自己的模型服务。', kicker: 'MODEL SETTINGS', icon: Settings2 },
  plugins: { title: '插件', subtitle: '管理当前环境的插件，按需导入更多能力。', kicker: 'PLUGIN LIBRARY', icon: Boxes },
};
const apiTypes = ['openai-completions', 'openai-responses', 'openai-codex-responses', 'anthropic-messages', 'google-generative-ai', 'github-copilot', 'bedrock-converse-stream', 'ollama'];
type ProviderDraft = Omit<ModelProvider, 'models'> & { models: (ModelProvider['models'][number] & { persisted?: boolean })[] };
const emptyProvider = (): ModelProvider => ({ id: '', baseUrl: '', api: 'openai-completions', hasApiKey: false, models: [{ id: '', name: '' }] });

export function ManagementPage(props: ManagementPageProps) {
  // Changing environments unmounts all editors, including secrets and pending read results.
  return <ManagementContent key={`${props.connectionKey}:${props.page}`} {...props} />;
}

function ManagementContent(props: ManagementPageProps) {
  const { page, connected, sessionKey, sessionModel, sessionBusy, onModelChanged, onReconnect } = props;
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [settings, setSettings] = useState<ModelSettings>();
  const [plugins, setPlugins] = useState<PluginList>();
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [restartRequired, setRestartRequired] = useState(false);
  const [search, setSearch] = useState('');
  const [skillFilter, setSkillFilter] = useState('all');
  const [selectedModel, setSelectedModel] = useState(sessionModel || '');
  const [defaultModel, setDefaultModel] = useState('');
  const [providerId, setProviderId] = useState('');
  const [provider, setProvider] = useState<ProviderDraft>(emptyProvider);
  const [removeModelIds, setRemoveModelIds] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [pluginSource, setPluginSource] = useState('');
  const alive = useRef(false);
  const request = useRef(0);
  const operation = useRef(false);
  const sessionRef = useRef(sessionKey);
  sessionRef.current = sessionKey;
  const locked = loading || !!pending;
  const disabled = !connected || locked;
  const copy = pageCopy[page];
  const Icon = copy.icon;

  const safeText = (value: string) => apiKey.trim() ? value.split(apiKey.trim()).join('••••••••') : value;

  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);
  useEffect(() => { setSelectedModel(sessionModel || ''); }, [sessionKey, sessionModel]);
  useEffect(() => {
    if (connected) void load();
    else { request.current++; setApiKey(''); setLoading(false); }
  }, [connected, page]);

  async function load(selectedProviderId = providerId) {
    const id = ++request.current;
    setLoading(true); setError('');
    const valid = () => alive.current && id === request.current;
    try {
      if (page === 'skills') {
        const result = await window.kuro.listSkills();
        if (valid()) setSkills(result);
      } else if (page === 'plugins') {
        const result = await window.kuro.listPlugins();
        if (valid()) setPlugins(result);
      } else {
        const [catalog, config] = await Promise.allSettled([window.kuro.listModels(), window.kuro.getModelSettings()]);
        if (!valid()) return;
        const failures: string[] = [];
        if (catalog.status === 'fulfilled') setModels(catalog.value);
        else failures.push(`模型列表：${errorText(catalog.reason)}`);
        if (config.status === 'fulfilled') {
          setSettings(config.value); setDefaultModel(config.value.defaultModel);
          const selected = config.value.providers.find(item => item.id === selectedProviderId);
          setRemoveModelIds([]);
          if (selected) setProvider({ ...selected, models: selected.models.map(model => ({ ...model, persisted: true })) });
          else if (selectedProviderId) { setProviderId(''); setProvider(emptyProvider()); }
        } else { setSettings(undefined); failures.push(`模型配置：${errorText(config.reason)}`); }
        setError(safeText(failures.join('\n')));
      }
    } catch (cause) { if (valid()) setError(safeText(errorText(cause))); }
    finally { if (valid()) setLoading(false); }
  }

  async function mutate(label: string, action: () => Promise<MutationResult | void>, after?: () => Promise<void> | void) {
    if (operation.current || !connected || sessionBusy) return;
    operation.current = true; setPending(label); setError(''); setNotice('');
    try {
      const result = await action();
      if (!alive.current) return;
      setNotice(safeText(result?.message || '已保存。'));
      if (result?.restartRequired) setRestartRequired(true);
      await after?.();
    } catch (cause) { if (alive.current) setError(safeText(errorText(cause))); }
    finally { operation.current = false; if (alive.current) setPending(''); }
  }

  function selectProvider(id: string) {
    setProviderId(id); setApiKey(''); setRemoveModelIds([]);
    const selected = settings?.providers.find(item => item.id === id);
    setProvider(selected ? { ...selected, models: selected.models.map(model => ({ ...model, persisted: true })) } : emptyProvider());
  }

  function isSavedDefault(id: string) {
    return settings?.defaultModel === `${provider.id.trim()}/${id}`;
  }

  function removeModel(index: number) {
    if (disabled || sessionBusy || !settings) return;
    const model = provider.models[index];
    if (!model) return;
    if (!model.persisted) {
      setProvider({ ...provider, models: provider.models.filter((_, position) => position !== index) });
    } else if (removeModelIds.includes(model.id)) {
      setRemoveModelIds(ids => ids.filter(id => id !== model.id));
    } else if (isSavedDefault(model.id)) {
      setError('不能删除默认模型，请先更改并保存默认模型。');
    } else {
      setRemoveModelIds(ids => [...new Set([...ids, model.id])]);
    }
  }

  function saveProvider(event: FormEvent) {
    event.preventDefault();
    if (!settings || sessionBusy) return;
    const normalizedModels = provider.models
      .filter(model => !model.persisted || !removeModelIds.includes(model.id))
      .map(model => ({ id: model.id.trim(), name: model.name.trim() || model.id.trim() }));
    if (removeModelIds.some(isSavedDefault)) { setError('不能删除默认模型，请先更改并保存默认模型。'); return; }
    if (normalizedModels.some(model => removeModelIds.includes(model.id))) { setError('同一模型不能同时保留和删除，请先撤销删除或修改新增模型 ID。'); return; }
    if ((!normalizedModels.length && !removeModelIds.length) || normalizedModels.some(model => !model.id)) { setError('请至少填写一个完整的模型 ID。'); return; }
    if (new Set(normalizedModels.map(model => model.id)).size !== normalizedModels.length) { setError('模型 ID 不能重复。'); return; }
    void mutate('保存服务配置', () => window.kuro.saveModelSettings({
      hash: settings.hash,
      provider: { id: provider.id.trim(), baseUrl: provider.baseUrl.trim(), api: provider.api, models: normalizedModels, ...(removeModelIds.length ? { removeModelIds } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) },
    }), async () => {
      setApiKey(''); setRemoveModelIds([]);
      setProvider({ ...provider, models: provider.models.filter(model => !model.persisted || !removeModelIds.includes(model.id)) });
      setProviderId(provider.id.trim()); await load(provider.id.trim());
    });
  }

  async function reconnect() {
    if (operation.current || sessionBusy) return;
    operation.current = true; setPending('重新连接'); setError('');
    try { await onReconnect(); if (alive.current) setRestartRequired(false); }
    catch (cause) { if (alive.current) setError(safeText(errorText(cause))); }
    finally { operation.current = false; if (alive.current) setPending(''); }
  }

  async function chooseSource() {
    if (operation.current) return;
    operation.current = true; setPending('选择插件'); setError('');
    try { const source = await window.kuro.choosePluginSource(); if (alive.current && source) setPluginSource(source); }
    catch (cause) { if (alive.current) setError(errorText(cause)); }
    finally { operation.current = false; if (alive.current) setPending(''); }
  }

  const query = search.trim().toLowerCase();
  const filteredSkills = skills.filter(skill => `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(query)
    && (skillFilter === 'all' || (skillFilter === 'ready' ? skill.eligible && !skill.disabled : !skill.eligible || skill.disabled)));
  const filteredPlugins = (plugins?.plugins || []).filter(plugin => `${plugin.name} ${plugin.id} ${plugin.description}`.toLowerCase().includes(query));
  const knownApis = apiTypes.includes(provider.api) ? apiTypes : [provider.api, ...apiTypes];
  const modelChoices = [...models];
  for (const id of [sessionModel, defaultModel]) {
    if (id && !modelChoices.some(model => model.id === id)) modelChoices.push({ id, name: id, provider: '' });
  }

  return <div className="settings-scroll management-scroll">
    <div className="management-content">
      <div className="management-intro">
        <div><span className="page-kicker">{copy.kicker}</span><h2><Icon size={25} />{copy.title}</h2><p>{copy.subtitle}</p></div>
        <button className="secondary-button" disabled={disabled} onClick={() => void load()} aria-label={`刷新${copy.title}`}><RefreshCw size={14} className={loading ? 'spin' : ''} />刷新</button>
      </div>
      {!connected && <div className="management-banner" role="status"><WifiOff size={18} /><div><strong>尚未连接 OpenClaw</strong><p>连接后即可读取和管理当前环境。</p></div><button className="secondary-button" disabled={!!pending} onClick={() => {
        setPending('连接中'); setError(''); void onReconnect().catch(cause => { if (alive.current) setError(errorText(cause)); }).finally(() => { if (alive.current) setPending(''); });
      }}>重新连接</button></div>}
      {error && <div className="management-message management-error" role="alert">{error}</div>}
      {pending && <div className="management-message" role="status"><LoaderCircle size={15} className="spin" />{pending}，请稍候…</div>}
      {notice && <div className="management-message management-success" role="status"><Check size={16} />{notice}</div>}
      {restartRequired && <div className="management-banner"><RefreshCw size={18} /><div><strong>{page === 'plugins' ? '插件已更新，需要重启网关' : '配置已更新，网关正在重新加载'}</strong><p>{page === 'plugins' ? '重启会短暂中断连接；完成后将重新连接。' : '重新加载会短暂中断连接，完成后可重新连接并刷新配置。'}</p></div>{page === 'plugins' ? <button className="secondary-button" disabled={disabled || sessionBusy} onClick={() => void mutate('重启网关', () => window.kuro.restartPluginGateway(), async () => { await onReconnect(); if (alive.current) setRestartRequired(false); })}>重启并连接</button> : <button className="secondary-button" disabled={locked || sessionBusy} onClick={() => void reconnect()}>重新连接</button>}</div>}

      {page === 'skills' && <>
        <div className="management-toolbar"><label className="management-search"><Search size={16} /><input aria-label="搜索 Skills" placeholder="搜索名称、描述或来源" value={search} onChange={event => setSearch(event.target.value)} /></label><select className="settings-input management-filter" aria-label="Skill 状态筛选" value={skillFilter} onChange={event => setSkillFilter(event.target.value)}><option value="all">全部状态</option><option value="ready">可用</option><option value="unavailable">暂不可用</option></select></div>
        <div className="management-count">{skills.length} 个 Skill · {skills.filter(skill => skill.eligible && !skill.disabled).length} 个可用</div>
        {loading && !skills.length ? <Loading /> : !filteredSkills.length ? <Empty text={skills.length ? '没有匹配的 Skill，试试其他关键词或状态。' : connected ? '当前环境没有返回任何 Skill。' : '连接后显示 Skill 列表。'} /> : <div className="management-grid">{filteredSkills.map((skill, index) => <article className="management-item" key={`${skill.source}:${skill.name}:${index}`}><div className="management-item-heading"><span className="management-item-icon"><Sparkles size={19} /></span><h3>{skill.name}</h3><span className={`management-badge ${skill.eligible && !skill.disabled ? 'ready' : 'muted'}`}>{skill.disabled ? '已禁用' : skill.eligible ? '可用' : '待配置'}</span></div><p>{skill.description || '暂无描述'}</p><div className="management-meta">来源：{skill.source || '未知'}</div>{skill.missing.length > 0 && <div className="management-dependencies"><strong>缺少依赖</strong><span>{skill.missing.join(' · ')}</span></div>}{skill.homepage && /^https?:\/\//i.test(skill.homepage) && <button className="text-button" onClick={() => void window.kuro.openExternal(skill.homepage!).catch(cause => { if (alive.current) setError(errorText(cause)); })}>查看使用说明 ↗</button>}</article>)}</div>}
      </>}

      {page === 'models' && <div className="management-sections">
        <section className="management-card"><div className="management-card-heading"><h3>当前对话模型</h3><span className="management-badge">仅此对话</span></div><p className="management-help">为侧栏当前选中的对话选择模型，后续消息使用此设置。</p><div className="management-field"><label htmlFor="session-model">模型</label><div className="management-inline"><select id="session-model" className="settings-input" value={selectedModel} disabled={disabled || sessionBusy} onChange={event => setSelectedModel(event.target.value)}><option value="">跟随默认模型</option>{modelChoices.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}</select><button className="primary-button" disabled={disabled || sessionBusy || !sessionKey} onClick={() => {
          const targetSession = sessionKey;
          void mutate('切换模型', () => window.kuro.switchSessionModel({ sessionKey: targetSession, model: selectedModel || null }), () => { if (sessionRef.current === targetSession) onModelChanged(); });
        }}>应用到对话</button></div></div>{sessionBusy && <p className="management-help">有对话正在生成，结束后可切换模型及保存配置。</p>}{!loading && !models.length && <p className="management-help">尚未发现可选模型，可以先在下方添加模型服务后刷新。</p>}</section>

        <section className="management-card"><div className="management-card-heading"><h3>默认模型</h3><span className="management-badge">全局配置</span></div><p className="management-help">用于未单独指定模型的对话。保存后可能需要网关重新加载。</p><form onSubmit={event => { event.preventDefault(); if (settings) void mutate('保存默认模型', () => window.kuro.saveModelSettings({ hash: settings.hash, defaultModel: defaultModel.trim() }), load); }}><div className="management-field"><label htmlFor="default-model">默认模型 ID</label><div className="management-inline"><input id="default-model" className="settings-input" list="management-model-options" placeholder="例如 openai/gpt-4.1" required value={defaultModel} disabled={disabled || sessionBusy || !settings} onChange={event => setDefaultModel(event.target.value)} /><datalist id="management-model-options">{modelChoices.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist><button className="primary-button" disabled={disabled || sessionBusy || !settings || !defaultModel.trim()}>保存默认模型</button></div></div></form></section>

        <section className="management-card"><div className="management-card-heading"><h3>模型服务</h3><span className="management-badge">API 配置</span></div><p className="management-help">填写服务地址与模型 ID。密钥不会回显，编辑已有服务时留空保留原密钥。</p><div className="management-field"><label htmlFor="provider-select">选择服务</label><select id="provider-select" className="settings-input" value={providerId} disabled={disabled || sessionBusy || !settings} onChange={event => selectProvider(event.target.value)}><option value="">＋ 添加模型服务</option>{settings?.providers.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></div>
          <form onSubmit={saveProvider}><fieldset disabled={disabled || sessionBusy || !settings} className="management-fieldset"><div className="management-two-columns"><div className="management-field"><label htmlFor="provider-id">服务 ID</label><input id="provider-id" className="settings-input" required pattern="[a-zA-Z0-9_.\-]+" placeholder="例如 my-provider" disabled={!!providerId} value={provider.id} onChange={event => setProvider({ ...provider, id: event.target.value })} /></div><div className="management-field"><label htmlFor="provider-api">API 类型</label><select id="provider-api" className="settings-input" value={provider.api} onChange={event => setProvider({ ...provider, api: event.target.value })}>{knownApis.map(api => <option key={api} value={api}>{api}</option>)}</select></div></div><div className="management-field"><label htmlFor="provider-url">服务地址</label><input id="provider-url" className="settings-input" type="url" required placeholder="https://api.example.com/v1" value={provider.baseUrl} onChange={event => setProvider({ ...provider, baseUrl: event.target.value })} /></div><div className="management-field"><label htmlFor="provider-key">API 密钥 <span>{provider.hasApiKey ? '已配置 · 留空保留' : '按服务要求填写'}</span></label><input id="provider-key" className="settings-input" type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={provider.hasApiKey ? '••••••••（已配置）' : '输入 API key'} /></div><div className="management-model-list"><div className="management-model-list-title"><strong>服务提供的模型</strong><button type="button" className="text-button" onClick={() => setProvider({ ...provider, models: [...provider.models, { id: '', name: '' }] })}><Plus size={14} />添加模型</button></div><p className="management-help">已有模型可修改名称、标记删除或撤销；点击“保存服务配置”后生效。默认模型需先更改并保存后才能删除。</p>{provider.models.map((model, index) => {
              const removed = !!model.persisted && removeModelIds.includes(model.id);
              const protectedDefault = !!model.persisted && isSavedDefault(model.id);
              return <div className={`management-model-row${removed ? ' is-removed' : ''}`} key={index}>
                <input className="settings-input" required readOnly={!!model.persisted} disabled={removed} aria-label={`模型 ${index + 1} ID`} placeholder="模型 ID，例如 gpt-4.1" value={model.id} onChange={event => setProvider({ ...provider, models: provider.models.map((item, position) => position === index ? { ...item, id: event.target.value } : item) })} />
                <input className="settings-input" disabled={removed} aria-label={`模型 ${index + 1} 名称`} placeholder="显示名称（可选）" value={model.name} onChange={event => setProvider({ ...provider, models: provider.models.map((item, position) => position === index ? { ...item, name: event.target.value } : item) })} />
                <button className="management-icon-button" type="button" disabled={protectedDefault && !removed} aria-label={`${removed ? '撤销删除模型' : '移除模型'} ${index + 1}`} title={removed ? '撤销删除' : protectedDefault ? '请先更改并保存默认模型' : model.persisted ? '标记删除，保存后生效' : '移除未保存的模型'} onClick={() => removeModel(index)}>{removed ? <Undo2 size={16} /> : <Trash2 size={16} />}</button>
                {(removed || protectedDefault) && <span className="management-model-status">{removed ? '待删除 · 保存后生效，可撤销' : '默认模型 · 请先更改并保存默认模型'}</span>}
              </div>;
            })}
            {!!removeModelIds.length && <p className="management-help" role="status">已标记删除 {removeModelIds.length} 个模型，保存服务配置后生效。</p>}</div><div className="management-card-footer"><button className="primary-button" disabled={!provider.id.trim() || (!provider.models.length && !removeModelIds.length)}><Check size={14} />保存服务配置</button></div></fieldset></form>
        </section>
      </div>}

      {page === 'plugins' && <>
        <section className="management-card management-import"><div className="management-card-heading"><h3><Download size={17} />导入插件</h3><span className="management-badge">{plugins?.environment || '当前网关环境'}</span></div><p className="management-help">输入兼容的 npm 包名，或选择本地插件目录、压缩包。安装完成后可能需要重启网关；所需账号与依赖需另行配置。</p><form onSubmit={event => { event.preventDefault(); void mutate('安装插件', () => window.kuro.installPlugin({ source: pluginSource.trim() }), async () => { setPluginSource(''); await load(); }); }}><label className="management-source-label" htmlFor="plugin-source">插件来源</label><input id="plugin-source" className="settings-input" required value={pluginSource} disabled={disabled} onChange={event => setPluginSource(event.target.value)} placeholder="@scope/plugin 或本地插件路径" /><div className="management-card-footer"><button className="secondary-button" type="button" disabled={disabled} onClick={() => void chooseSource()}><FolderOpen size={15} />选择本地插件</button><button className="primary-button" disabled={disabled || sessionBusy || !pluginSource.trim()}><Download size={15} />安装插件</button></div>{sessionBusy && <p className="management-help">有对话正在生成，结束后可安装插件。</p>}</form></section>
        <div className="management-toolbar"><label className="management-search"><Search size={16} /><input aria-label="搜索已安装插件" placeholder="搜索已安装插件" value={search} onChange={event => setSearch(event.target.value)} /></label><span className="management-count">{plugins?.plugins.length || 0} 个插件</span><button className="secondary-button" disabled={disabled || sessionBusy} onClick={() => void mutate('重启网关', () => window.kuro.restartPluginGateway(), async () => { await onReconnect(); if (alive.current) setRestartRequired(false); })}><RefreshCw size={14} />重启网关</button></div>
        {!!plugins?.diagnostics.length && <details className="management-diagnostics"><summary>环境诊断（{plugins.diagnostics.length}）</summary>{plugins.diagnostics.map((diagnostic, index) => <p key={index}>{diagnostic}</p>)}</details>}
        {loading && !plugins ? <Loading /> : !filteredPlugins.length ? <Empty text={plugins?.plugins.length ? '没有匹配的插件，试试其他关键词。' : connected ? '当前环境没有返回插件，可从上方导入。' : '连接后显示已安装插件。'} /> : <div className="management-grid">{filteredPlugins.map((plugin, index) => <article className="management-item" key={`${plugin.id}:${index}`}><div className="management-item-heading"><span className="management-item-icon"><Boxes size={19} /></span><h3>{plugin.name || plugin.id}</h3><span className={`management-badge ${plugin.error ? 'problem' : plugin.status === 'loaded' ? 'ready' : 'muted'}`}>{plugin.error ? '加载异常' : plugin.status === 'loaded' ? '已加载' : plugin.status === 'disabled' || !plugin.enabled ? '已禁用' : plugin.status || '待加载'}</span></div><p>{plugin.description || '暂无描述'}</p><div className="management-meta">{plugin.id}{plugin.version ? ` · v${plugin.version}` : ''}</div>{plugin.source && <div className="management-meta">来源：{plugin.source}</div>}{plugin.error && <div className="management-dependencies management-plugin-error">{plugin.error}</div>}</article>)}</div>}
      </>}
    </div>
  </div>;
}

function Loading() { return <div className="management-empty" role="status"><LoaderCircle className="spin" size={23} /><p>正在读取当前环境…</p></div>; }
function Empty({ text }: { text: string }) { return <div className="management-empty"><Boxes size={26} /><p>{text}</p></div>; }
