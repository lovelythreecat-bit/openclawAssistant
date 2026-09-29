import { useEffect, useState } from 'react';
import { ChevronDown, Cpu, LoaderCircle, RefreshCw, Settings2 } from 'lucide-react';
import type { ModelOption } from './management-types';
import { errorText } from './useWorkspace';

interface Props {
  connected: boolean;
  connectionKey: string;
  model?: string;
  busy: boolean;
  switching: boolean;
  onChange: (model: string | null) => Promise<void>;
  onConfigure: () => void;
}

export function ChatModelSelect({ connected, connectionKey, model, busy, switching, onChange, onConfigure }: Props) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setModels([]); setError(''); setLoading(connected);
    if (connected && window.kuro) {
      void window.kuro.listModels().then(value => {
        if (active) setModels(value);
      }).catch(reason => {
        if (active) setError(`模型列表加载失败：${errorText(reason)}`);
      }).finally(() => { if (active) setLoading(false); });
    }
    return () => { active = false; };
  }, [connected, connectionKey, reload]);
  const choices = model && !models.some(item => item.id === model)
    ? [...models, { id: model, name: model, provider: '' }] : models;
  const disabled = !connected || loading || busy || switching || !!error;
  return <div className="chat-model-picker">
    <div className="chat-model-controls">
      <div className={`chat-model-field${disabled ? ' is-disabled' : ''}`}>
      <Cpu size={14} className="chat-model-icon" aria-hidden="true" />
      <select className="chat-model-select" aria-label="当前对话模型" value={model || ''} disabled={disabled}
        aria-describedby={error ? 'chat-model-error' : undefined}
        title={!connected ? '连接网关后可切换模型' : busy ? '回复结束后可切换模型' : '选择后立即应用到当前对话'}
        onChange={event => void onChange(event.target.value || null)}>
        <option value="">{loading ? '正在加载模型…' : '跟随默认模型'}</option>
        {choices.map(item => <option key={item.id} value={item.id}>{item.name === item.id ? item.id : `${item.name} · ${item.id}`}</option>)}
      </select>
      {switching || loading
        ? <LoaderCircle size={14} className="chat-model-chevron spin" aria-label={switching ? '正在切换模型' : '正在加载模型'} />
        : <ChevronDown size={14} className="chat-model-chevron" aria-hidden="true" />}
      </div>
      <button type="button" className="icon-button" title="刷新模型列表" aria-label="刷新模型列表" disabled={!connected || loading || switching} onClick={() => setReload(value => value + 1)}><RefreshCw size={13} className={loading ? 'spin' : ''} /></button>
      <button type="button" className="icon-button" title="配置模型服务" aria-label="配置模型服务" onClick={onConfigure}><Settings2 size={14} /></button>
    </div>
    {error && <span id="chat-model-error" className="chat-model-feedback" role="alert">{error}</span>}
    {!error && connected && !loading && !models.length && <span className="chat-model-feedback">暂无可选模型，请配置模型服务。</span>}
  </div>;
}
