import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Boxes, Check, ChevronRight, CircleHelp, Code2, Coffee, Compass, Cpu, ExternalLink, Flower2, Heart, LoaderCircle, MessageCircle, Plus, Radio, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Square, Unplug, Wifi, WifiOff, Wrench, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import mascot from '../assets/concepts/mascot-welcome-v1.png';
import type { ChatMessage, ConnectionStatus, PublicSettings, Session, SettingsInput } from './types';
import { errorText, useWorkspace } from './useWorkspace';
import { Companion } from './live2d/Companion';
import { ManagementPage } from './Management';

const titleOf = (session?: Session) => session?.displayName || session?.derivedTitle || session?.label || (session ? session.key : '新的对话');
const stateLabel = (status: ConnectionStatus) => ({ connected: '已连接', connecting: '连接中', disconnected: '未连接', error: '连接异常' })[status.state];
const suggestions = [
  { icon: Compass, label: '理一理今天的思路', description: '把脑海里的想法变成清晰的计划', prompt: '我想和你一起整理今天的任务，请先问问我有哪些事情需要完成。', color: 'pink' },
  { icon: Code2, label: '一起解决代码问题', description: '读懂代码，找到问题的突破口', prompt: '我遇到了一个代码问题，请和我一起分析。我会在下一条消息里提供代码和报错。', color: 'lavender' },
  { icon: Coffee, label: '聊聊新的灵感', description: '无论大事小事，我都认真听', prompt: '我想和你聊聊一个新想法，帮我从几个不同的角度探索它吧。', color: 'peach' },
];

function Avatar({ small = false }: { small?: boolean }) { return <span className={`avatar ${small ? 'avatar-small' : ''}`}><img src={mascot} alt="库洛" /></span>; }
function Status({ status }: { status: ConnectionStatus }) { return <span className={`status status-${status.state}`}><i />{stateLabel(status)}</span>; }
function EmptyNotice({ text, retry }: { text: string; retry?: () => void }) { return <div className="empty-notice"><MessageCircle size={25} /><p>{text}</p>{retry && <button className="text-button" onClick={retry}>再试一次 <RefreshCw size={13} /></button>}</div>; }
function MarkdownMessage({ message, onError }: { message: ChatMessage; onError: (text: string) => void }) {
  const content = typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n\n');
  const tools = typeof message.content === 'string' ? [] : message.content.filter(block => block.type === 'tool_use' || block.type === 'toolCall');
  return <><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => <a href={href} onClick={event => { event.preventDefault(); if (href && /^https?:\/\//i.test(href)) void window.kuro.openExternal(href).catch(error => onError(errorText(error))); }} rel="noreferrer">{children}<ExternalLink size={11} /></a>,
    img: ({ alt }) => <span className="image-placeholder">[图片{alt ? `：${alt}` : ''}]</span>,
  }}>{content || (message.role === 'toolResult' || message.role === 'tool' ? '工具已返回结果。' : '')}</ReactMarkdown></div>{tools.map((tool, index) => <div className="tool-message" key={index}><Wrench size={13} />调用工具 · {tool.name || '工具'}</div>)}</>;
}

export default function App() {
  const work = useWorkspace();
  const [page, setPage] = useState<'chat' | 'gateway' | 'settings' | 'skills' | 'models' | 'plugins'>('chat');
  const [search, setSearch] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const composing = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const current = work.current;
  const selectedSession = work.sessions.find(session => session.key === work.selected);
  const connected = work.status.state === 'connected';
  const managementPage = page === 'skills' || page === 'models' || page === 'plugins' ? page : undefined;
  const managementTitle = { skills: 'Skills 能力库', models: '模型与服务', plugins: '插件管理' };
  const sessionModel = selectedSession?.model && selectedSession.modelProvider && !selectedSession.model.startsWith(`${selectedSession.modelProvider}/`)
    ? `${selectedSession.modelProvider}/${selectedSession.model}` : selectedSession?.model;
  const visibleSessions = work.sessions.filter(session => `${titleOf(session)} ${session.lastMessagePreview || ''}`.toLowerCase().includes(search.toLowerCase()));
  const shownMessages = current.stream ? [...current.messages, current.stream] : current.messages;
  const welcome = !current.messages.length && !current.run && !current.loading && !current.error;
  useEffect(() => {
    follow.current = true; setShowJump(false);
  }, [work.selected]);
  useEffect(() => {
    if (follow.current && scrollArea.current) scrollArea.current.scrollTop = scrollArea.current.scrollHeight;
  }, [current.messages, current.stream, current.activity, page]);
  useEffect(() => {
    if (composer.current) { composer.current.style.height = 'auto'; composer.current.style.height = `${Math.min(composer.current.scrollHeight, 132)}px`; }
  }, [current.draft, page]);
  const prefill = (text: string) => { work.setDraft(text); composer.current?.focus(); };
  const submit = (event?: FormEvent) => { event?.preventDefault(); follow.current = true; void work.send(); };
  const reconnectManagement = async () => {
    if (!await work.connectionAction('connect')) throw new Error('网关尚未连接成功，请稍后重试。');
  };
  return <div className="app-shell">
    <nav className="rail" aria-label="主导航">
      <button className="brand-mark" title="库洛的工作台" onClick={() => setPage('chat')} aria-label="库洛首页"><Flower2 size={30} strokeWidth={2.1} /></button>
      <div className="rail-nav">
        {([{ key: 'chat', icon: MessageCircle, label: '聊天' }, { key: 'skills', icon: Sparkles, label: 'Skills' }, { key: 'models', icon: Cpu, label: '模型' }, { key: 'plugins', icon: Boxes, label: '插件' }, { key: 'gateway', icon: Radio, label: '网关' }, { key: 'settings', icon: Settings2, label: '设置' }] as const).map(item => <button key={item.key} className={`rail-button ${page === item.key ? 'active' : ''}`} onClick={() => setPage(item.key)} aria-current={page === item.key ? 'page' : undefined}><item.icon size={21} /><span>{item.label}</span></button>)}
      </div>
      <div className="rail-bottom"><span className="tiny-flower">✳</span><Avatar small /><span className="rail-caption">KURO</span></div>
    </nav>

    <aside className="session-sidebar">
      <div className="sidebar-brand"><div><h1>库洛<span>✿</span></h1><p>你的 OpenClaw 小搭档</p></div><span className="brand-tag">桌面版</span></div>
      <button className="new-chat" onClick={() => { work.createSession(); setPage('chat'); composer.current?.focus(); }}><Plus size={18} />开启新对话<span>✧</span></button>
      <label className="session-search"><Search size={15} /><input placeholder="寻找一段对话…" aria-label="搜索会话" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div className="section-label"><span>我们的对话 <small>{work.sessions.length ? work.sessions.length : ''}</small></span><button className="icon-button" title="刷新会话" aria-label="刷新会话" disabled={!connected || work.sessionLoading} onClick={() => void work.refreshSessions()}><RefreshCw size={14} className={work.sessionLoading ? 'spin' : ''} /></button></div>
      <div className="session-list">
        {work.sessionError && <div className="sidebar-error" role="alert">{work.sessionError}<button className="text-button" onClick={() => void work.refreshSessions()}>重新加载</button></div>}
        {work.sessionLoading && !work.sessions.length ? <EmptyNotice text="正在寻找你的对话…" /> : visibleSessions.length ? visibleSessions.map(session => <button className={`session-item ${work.selected === session.key ? 'selected' : ''}`} key={session.key} onClick={() => { work.selectSession(session); setPage('chat'); }}><span className="session-icon"><MessageCircle size={16} /></span><span className="session-info"><strong>{titleOf(session)}</strong><small>{work.states[session.key]?.run ? '库洛正在回复…' : session.lastMessagePreview || (session.updatedAt ? formatDate(session.updatedAt) : '点击继续对话')}</small></span>{work.states[session.key]?.run ? <LoaderCircle size={13} className="spin" /> : work.selected === session.key ? <span className="selected-dot" /> : null}</button>) : <EmptyNotice text={search ? '还没有找到这段对话' : connected ? '故事从第一句「你好」开始' : '连接网关后，对话会出现在这里'} />}
      </div>
      <div className="sidebar-note"><Heart size={15} /><p>每个小小的想法，<br />都值得被认真对待。</p><span>✧</span></div>
      <button className="gateway-mini" onClick={() => setPage('gateway')}><span className={`gateway-mini-icon ${connected ? 'online' : ''}`}>{connected ? <Wifi size={17} /> : <WifiOff size={17} />}</span><span><strong>OpenClaw 网关</strong><small>{stateLabel(work.status)}</small></span><ChevronRight size={15} /></button>
    </aside>

    <main className="workspace">
      <header className="workspace-header"><div className="header-heading"><span className="header-icon">{page === 'chat' ? <MessageCircle size={17} /> : page === 'gateway' ? <Radio size={18} /> : managementPage === 'skills' ? <Sparkles size={18} /> : managementPage === 'plugins' ? <Boxes size={18} /> : managementPage === 'models' ? <Cpu size={18} /> : <Settings2 size={18} />}</span><div><h2>{page === 'chat' ? titleOf(selectedSession) : managementPage ? managementTitle[managementPage] : page === 'gateway' ? '连接你的小宇宙' : '让工作台更合心意'}</h2><span>{page === 'chat' ? '和库洛一起，让想法慢慢发光' : managementPage ? '当前 OpenClaw 环境' : page === 'gateway' ? 'OpenClaw 网关' : '工作台设置'}</span></div></div><div className="header-actions"><Status status={work.status} />{page === 'chat' && <button className="icon-button" title="刷新聊天记录" aria-label="刷新聊天记录" disabled={!connected || current.loading || !!current.run} onClick={() => void work.loadHistory(work.selected)}><RefreshCw size={16} className={current.loading ? 'spin' : ''} /></button>}</div></header>
      {work.notice && <div className="app-notice" role="status"><CircleHelp size={16} /><span>{work.notice}</span><button aria-label="关闭提示" className="icon-button" onClick={() => work.setNotice('')}><X size={15} /></button></div>}
      {managementPage ? <ManagementPage page={managementPage} connected={connected} connectionKey={`${work.settings?.url || work.status.endpoint}|${work.settings?.distro || ''}`} sessionKey={work.selected} sessionModel={sessionModel} sessionBusy={Object.values(work.states).some(state => !!state.run)} onModelChanged={() => void work.refreshSessions()} onReconnect={reconnectManagement} /> : page === 'chat' ? <div className="chat-layout"><div className="chat-main">
        <div className={`conversation-scroll ${welcome ? 'is-welcome' : ''}`} ref={scrollArea} onScroll={() => { const area = scrollArea.current; if (area) { follow.current = area.scrollHeight - area.scrollTop - area.clientHeight < 90; setShowJump(!follow.current); } }}>
          {welcome ? <section className="welcome">
            <div className="welcome-hero"><div className="welcome-copy"><span className="eyebrow"><span />A LITTLE COMPANY, A LOT OF POSSIBILITY</span><div className="hello-sticker">今天，也一起加油吧 <Heart size={12} /></div><h2>你好呀，<br />我是<span>库洛<svg viewBox="0 0 180 16" aria-hidden="true"><path d="M3 11 Q85 -3 177 9" /></svg></span><span className="hello-star">✧</span></h2><p>带上你的问题、灵感和一点点好奇心。<br />我在这里，陪你把想法变成现实。</p><div className="welcome-signature"><Flower2 size={17} /><span>你的专属 OpenClaw 小搭档</span></div></div><div className="hero-art"><div className="art-halo" /><span className="art-star star-one">✦</span><span className="art-star star-two">✧</span><img src={mascot} alt="粉色长发的库洛抱着笔记本电脑，坐在龙虾软垫上向你挥手" /><span className="art-caption"><Heart size={12} fill="currentColor" /> 很高兴遇见你！</span></div></div>
            <div className="suggestion-heading"><Sparkles size={15} /><span>不妨从这里开始</span><i /></div>
            <div className="suggestions">{suggestions.map(item => <button className={`suggestion ${item.color}`} key={item.label} onClick={() => prefill(item.prompt)}><span className="suggestion-icon"><item.icon size={19} /></span><strong>{item.label}</strong><p>{item.description}</p><ArrowRight size={16} className="suggestion-arrow" /></button>)}</div>
          </section> : <div className="messages">
            {current.loading && !current.messages.length && <div className="history-loading"><LoaderCircle className="spin" size={20} />正在翻开这段对话…</div>}
            {current.messages.length >= 200 && <div className="history-limit">显示最近 200 条记录</div>}
            {shownMessages.map((message, index) => <article className={`message message-${message.role === 'user' ? 'user' : 'assistant'}`} key={message.id || `${index}-${message.role}`}>
              {message.role !== 'user' && <Avatar small />}
              <div className="message-body"><div className="message-meta"><strong>{message.role === 'user' ? '你' : message.role === 'toolResult' || message.role === 'tool' ? message.toolName || '工具结果' : '库洛'}</strong>{message.role !== 'user' && <span>KURO</span>}{message.timestamp && <time>{formatTime(message.timestamp)}</time>}</div><div className="message-bubble"><MarkdownMessage message={message} onError={work.setNotice} /></div></div>
            </article>)}
            {current.run && <div className="run-activity" role="status"><span className="thinking-dots"><i /><i /><i /></span><span>{current.activity || (current.run.stopping ? '正在等待停止确认…' : current.stream ? '库洛正在写下回复…' : '库洛正在认真思考…')}</span></div>}
          </div>}
        </div>
        {showJump && <button className="jump-button" onClick={() => { follow.current = true; setShowJump(false); scrollArea.current?.scrollTo({ top: scrollArea.current.scrollHeight, behavior: 'auto' }); }}><ArrowDown size={15} />回到最新</button>}
        <div className="composer-area">
          {current.error && <div className="chat-error" role="alert"><CircleHelp size={15} /><span>{current.error}</span><button className="text-button" disabled={!connected || !!current.run || current.loading} onClick={() => void work.loadHistory(work.selected)}>刷新记录</button></div>}
          {!connected && <div className="offline-hint"><WifiOff size={13} /><span>{work.status.state === 'connecting' ? '正在连接网关，请稍等一下…' : '连接 OpenClaw 网关，就可以和库洛聊天了'}</span><button onClick={() => setPage('gateway')}>去连接 <ArrowRight size={12} /></button></div>}
          <form className={`composer ${current.run ? 'is-running' : ''}`} onSubmit={submit}>
            <textarea ref={composer} aria-label="发送给库洛的消息" placeholder="有什么想和库洛聊聊的？" value={current.draft} rows={2} onChange={event => work.setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.nativeEvent.keyCode !== 229) { event.preventDefault(); submit(); } }} />
            <div className="composer-bottom"><button type="button" className="composer-context model-shortcut" title="切换或配置模型" onClick={() => setPage('models')}><span className="model-dot" /><span>OpenClaw</span><span className="composer-divider">/</span><span>{sessionModel || '默认模型'}</span><ChevronRight size={12} /></button>{current.run ? <button className="send-button stop-button" type="button" onClick={() => void work.stop()} disabled={current.run.stopping} title="停止回复" aria-label="停止回复">{current.run.stopping ? <LoaderCircle size={18} className="spin" /> : <Square size={15} fill="currentColor" />}</button> : <button className="send-button" disabled={!connected || !current.draft.trim() || current.loading} title="发送消息" aria-label="发送消息"><ArrowUp size={21} /></button>}</div>
          </form>
          <div className="composer-footer"><span>Enter 发送 <i>·</i> Shift + Enter 换行</span><span><ShieldCheck size={11} />通过本机网关连接</span></div>
        </div>
      </div><Companion thinking={!!current.run} replying={!!current.stream} /></div> : page === 'gateway' ? <div className="settings-scroll"><div className="page-intro"><span className="page-kicker">A BRIDGE TO YOUR IDEAS</span><h2>连接好了，<span>灵感就出发。</span></h2><p>库洛通过本机 OpenClaw 网关，与你的助手一起工作。</p></div><section className="gateway-card"><div className="gateway-card-top"><span className="large-icon"><Radio size={29} /></span><Status status={work.status} /></div><h3>OpenClaw Gateway</h3><p>{work.status.message || (connected ? '连接已就绪，库洛随时听你说。' : '准备好后，让库洛和你的网关见个面。')}</p><dl className="connection-details"><div><dt>网关地址</dt><dd>{work.status.endpoint || work.settings?.url || '尚未配置'}</dd></div><div><dt>网关版本</dt><dd>{work.status.version || '连接后显示'}</dd></div><div><dt>配置来源</dt><dd>{work.settings?.credentialSource === 'wsl' ? `WSL · ${work.settings.distro}` : work.settings?.credentialSource === 'manual' ? '手动配置' : '尚未配置凭据'}</dd></div></dl><div className="card-actions"><button className="primary-button" disabled={work.busy || work.status.state === 'connecting' || !window.kuro} onClick={() => void work.connectionAction('connect')}>{work.busy || work.status.state === 'connecting' ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{connected ? '重新连接' : '连接网关'}</button>{connected && <button className="secondary-button" disabled={work.busy} onClick={() => void work.connectionAction('disconnect')}><Unplug size={16} />断开连接</button>}<button className="text-button" onClick={() => setPage('settings')}>连接设置 <ChevronRight size={14} /></button></div></section><div className="soft-info"><ShieldCheck size={21} /><div><strong>熟悉的 OpenClaw，独立的桌面陪伴</strong><p>使用现有的 WSL 配置，也可以在设置中手动填写本机地址和凭据。</p></div></div></div> : <SettingsPage settings={work.settings} busy={work.busy} save={work.save} importWsl={work.importWsl} />}
    </main>
  </div>;
}

function SettingsPage({ settings, busy, save, importWsl }: { settings?: PublicSettings; busy: boolean; save: (input: SettingsInput) => Promise<boolean>; importWsl: (distro: string) => Promise<void> }) {
  const [url, setUrl] = useState(settings?.url || 'ws://127.0.0.1:18789');
  const [distro, setDistro] = useState(settings?.distro || 'Ubuntu');
  const [token, setToken] = useState('');
  const [credentialKind, setCredentialKind] = useState<'token' | 'password'>('token');
  useEffect(() => { if (settings) { setUrl(settings.url); setDistro(settings.distro); setToken(''); } }, [settings]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const credential = credentialKind === 'token' ? token.trim() : token;
    const saved = await save({ url: url.trim(), distro: distro.trim(), ...(credential ? { [credentialKind]: credential } : {}) });
    if (saved) setToken('');
  };
  return <div className="settings-scroll"><div className="page-intro"><span className="page-kicker">MAKE YOURSELF AT HOME</span><h2>你的工作台，<span>听你的。</span></h2><p>设置好连接，把剩下的时间留给好想法。</p></div><form className="settings-card" onSubmit={submit}><div className="settings-section-title"><Settings2 size={20} /><div><h3>网关连接</h3><p>连接运行在这台电脑上的 OpenClaw</p></div></div><label className="field-label" htmlFor="gateway-url">网关地址</label><input className="settings-input" id="gateway-url" value={url} onChange={event => setUrl(event.target.value)} placeholder="ws://127.0.0.1:18789" required spellCheck={false} /><p className="field-hint">支持 localhost、127.0.0.1 或 [::1] 的 WebSocket 地址。</p><label className="field-label" htmlFor="wsl-distro">WSL 发行版</label><div className="field-row"><input className="settings-input" id="wsl-distro" value={distro} onChange={event => setDistro(event.target.value)} placeholder="Ubuntu" required /><button className="secondary-button" disabled={busy || !window.kuro || !distro.trim()} type="button" onClick={() => void importWsl(distro.trim())}><ArrowDown size={15} />从 WSL 导入</button></div><p className="field-hint">从该发行版的 OpenClaw 配置中读取网关与认证信息。</p><div className="settings-divider" />
    <label className="field-label" htmlFor="credential-kind">认证方式</label>
    <select className="settings-input" id="credential-kind" value={credentialKind} onChange={event => { setCredentialKind(event.target.value as 'token' | 'password'); setToken(''); }}><option value="token">Token 令牌</option><option value="password">Password 密码</option></select>
    <label className="field-label" htmlFor={`gateway-${credentialKind}`}>{credentialKind === 'token' ? '认证令牌' : '认证密码'} <span>可选</span></label>
    <input className="settings-input" type="password" id={`gateway-${credentialKind}`} autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} placeholder={settings?.hasCredential ? '已保存凭据，留空以保留' : credentialKind === 'token' ? '手动粘贴网关 Token' : '输入网关认证密码'} />
    <div className="credential-note"><ShieldCheck size={14} />{settings?.hasCredential ? '已有认证凭据，保存的内容不会在此显示。' : '凭据仅用于本机网关连接。'}</div><div className="settings-footer"><p>保存后将清空当前会话视图并断开连接，请重新连接网关。</p><button className="primary-button" disabled={busy || !window.kuro} type="submit">{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存设置</button></div></form><div className="about-card"><Avatar small /><div><strong>库洛 <span>KURO</span></strong><p>给你的 OpenClaw，一个温暖的桌面小窝。</p></div><Heart size={20} /></div></div>;
}
function formatDate(value: number) { const date = new Date(value < 1e12 ? value * 1000 : value); return Number.isNaN(date.getTime()) ? '继续对话' : date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }); }
function formatTime(value: number) { const date = new Date(value < 1e12 ? value * 1000 : value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
