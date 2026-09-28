import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatEvent, ConnectionStatus, PublicSettings, Session, SettingsInput } from './types';
import { acknowledgeRun, applyChatEvent, beginRun, connectionLost, emptySession, failRun, type SessionState } from './workspace';

export const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';
const newKey = () => `agent:main:kuro-${crypto.randomUUID()}`;
const endpointIdentity = (url: string) => { try { return new URL(url).href; } catch { return url; } };
const noMatchingRun = (value: unknown) => !!value && typeof value === 'object'
  && 'ok' in value && value.ok === true && 'aborted' in value && value.aborted === false
  && 'runIds' in value && Array.isArray(value.runIds) && value.runIds.length === 0;
export function useWorkspace() {
  const [selected, setSelected] = useState(newKey);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [localSessions, setLocalSessions] = useState<Session[]>([]);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [states, setStates] = useState<Record<string, SessionState>>({});
  const stateRef = useRef(states);
  const [status, setStatus] = useState<ConnectionStatus>({ state: 'disconnected', endpoint: '' });
  const statusRef = useRef(status);
  const [settings, setSettings] = useState<PublicSettings>();
  const settingsRef = useRef<PublicSettings | undefined>(undefined);
  const settingsRequest = useRef(0);
  const generation = useRef(0);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const listRequest = useRef(0);
  const historyRequest = useRef<Record<string, number>>({});
  const initialKey = useRef(selected);
  const resetWorkspace = useCallback(() => {
    generation.current++;
    listRequest.current++;
    historyRequest.current = {};
    const key = newKey();
    stateRef.current = { [key]: { ...emptySession(), loaded: true } };
    setStates(stateRef.current); setSelected(key);
    setSessions([]); setLocalSessions([]); setSessionError(''); setSessionLoading(false);
  }, []);
  const update = useCallback((key: string, fn: (state: SessionState) => SessionState) => {
    const prior = stateRef.current[key] ?? emptySession();
    const next = fn(prior);
    stateRef.current = { ...stateRef.current, [key]: next };
    setStates(stateRef.current);
    return next;
  }, []);
  const refreshSessions = useCallback(async () => {
    if (!window.kuro || statusRef.current.state !== 'connected') return;
    const scope = generation.current;
    const request = ++listRequest.current;
    setSessionLoading(true); setSessionError('');
    try {
      const result = await window.kuro.listSessions();
      if (scope === generation.current && request === listRequest.current) setSessions(result);
    } catch (error) { if (scope === generation.current && request === listRequest.current) setSessionError(errorText(error)); }
    finally { if (scope === generation.current && request === listRequest.current) setSessionLoading(false); }
  }, []);
  const applySettings = useCallback((value: PublicSettings, forceReset = false) => {
    const prior = settingsRef.current;
    const changed = prior && (endpointIdentity(prior.url) !== endpointIdentity(value.url) || prior.distro !== value.distro);
    if (forceReset || changed) { resetWorkspace(); if (statusRef.current.state === 'connected') void refreshSessions(); }
    settingsRef.current = value;
    if (!prior || JSON.stringify(prior) !== JSON.stringify(value)) setSettings(value);
  }, [refreshSessions, resetWorkspace]);
  const refreshSettings = useCallback(async () => {
    const request = ++settingsRequest.current;
    try { const value = await window.kuro.getSettings(); if (request === settingsRequest.current) applySettings(value); }
    catch (error) { if (request === settingsRequest.current) setNotice(errorText(error)); }
  }, [applySettings]);
  const loadHistory = useCallback(async (key: string, preserveError = false) => {
    if (!window.kuro || statusRef.current.state !== 'connected' || stateRef.current[key]?.run) return;
    const scope = generation.current;
    const request = (historyRequest.current[key] ?? 0) + 1;
    historyRequest.current[key] = request;
    const revision = update(key, state => ({ ...state, loading: true, error: preserveError ? state.error : undefined })).revision;
    try {
      const history = await window.kuro.history(key);
      if (scope !== generation.current || historyRequest.current[key] !== request) return;
      update(key, state => state.revision !== revision || state.run ? state : { ...state, messages: history.messages, stream: undefined, loading: false, loaded: true });
    } catch (error) {
      if (scope !== generation.current || historyRequest.current[key] !== request) return;
      update(key, state => state.revision !== revision ? state : { ...state, loading: false, error: `记录加载失败：${errorText(error)}` });
    }
  }, [update]);
  const afterRun = useCallback((key: string, previous: SessionState, next: SessionState) => {
    if (previous.run && !next.run && next.completed) { void refreshSessions(); void loadHistory(key, true); }
  }, [loadHistory, refreshSessions]);
  useEffect(() => {
    if (!window.kuro) { setNotice('请从库洛桌面应用打开此工作台，以连接本地 OpenClaw。'); return; }
    let active = true;
    let statusUpdates = 0;
    const handleStatus = (next: ConnectionStatus) => {
      if (!active) return;
      const wasConnected = statusRef.current.state === 'connected';
      const priorEndpoint = statusRef.current.endpoint;
      const changedEndpoint = priorEndpoint && next.endpoint && endpointIdentity(priorEndpoint) !== endpointIdentity(next.endpoint);
      if (changedEndpoint && (!settingsRef.current || endpointIdentity(settingsRef.current.url) !== endpointIdentity(next.endpoint))) resetWorkspace();
      statusRef.current = next; setStatus(next);
      if (next.state !== 'connected') {
        listRequest.current++; setSessionLoading(false);
        for (const key of Object.keys(stateRef.current)) update(key, connectionLost);
      } else if (!wasConnected || changedEndpoint) void refreshSessions();
      void refreshSettings();
    };
    const unsubscribeStatus = window.kuro.onStatus(next => { statusUpdates++; handleStatus(next); });
    const unsubscribeEvent = window.kuro.onEvent(event => {
      if (!active) return;
      if (event.event === 'chat') {
        const payload = event.payload as ChatEvent | undefined;
        if (!payload || typeof payload.sessionKey !== 'string' || typeof payload.runId !== 'string' || !['delta', 'final', 'aborted', 'error'].includes(payload.state)) return;
        const previous = stateRef.current[payload.sessionKey];
        if (!previous?.run) return;
        const next = update(payload.sessionKey, state => applyChatEvent(state, payload.sessionKey, payload));
        afterRun(payload.sessionKey, previous, next);
      }
      if (event.event === 'agent') {
        const payload = event.payload as { sessionKey?: string; runId?: string; stream?: string; data?: { name?: string; phase?: string } } | undefined;
        if (!payload?.sessionKey || payload.stream !== 'tool') return;
        update(payload.sessionKey, state => {
          if (!state.run || (payload.runId !== state.run.id && payload.runId !== state.run.requestedId)) return state;
          const name = typeof payload.data?.name === 'string' ? payload.data.name : '工具';
          const phase = payload.data?.phase;
          return { ...state, activity: `${name} · ${phase === 'end' || phase === 'result' ? '已返回结果' : phase === 'start' ? '正在运行' : '处理中'}` };
        });
      }
    });
    void window.kuro.getStatus().then(next => { if (!statusUpdates) handleStatus(next); }).catch(error => { if (active) setNotice(errorText(error)); });
    void refreshSettings();
    update(initialKey.current, state => ({ ...state, loaded: true }));
    return () => { active = false; unsubscribeStatus(); unsubscribeEvent(); };
  }, [afterRun, refreshSessions, refreshSettings, resetWorkspace, update]);
  const selectSession = (session: Session) => {
    setSelected(session.key);
    if (!stateRef.current[session.key]?.loaded && !stateRef.current[session.key]?.run) void loadHistory(session.key);
  };
  const createSession = () => {
    const key = newKey();
    update(key, state => ({ ...state, loaded: true }));
    setSelected(key);
    setLocalSessions(prior => [{ key, displayName: '新的对话', updatedAt: Date.now() }, ...prior]);
  };
  const stopRun = async (key: string, requestId: string, scope: number) => {
    const isCurrent = () => scope === generation.current && stateRef.current[key]?.run?.requestedId === requestId;
    const run = stateRef.current[key]?.run;
    if (!isCurrent() || !run || run.ackPending) return;
    try {
      let result = await window.kuro.abort({ sessionKey: key, runId: run.id });
      if (!isCurrent()) return;
      // A missing run ID is not a pending acknowledgment. Ask the gateway to
      // stop the current session, which may now be tracked by a different ID.
      let sessionChecked = false;
      if (noMatchingRun(result)) {
        result = await window.kuro.abort({ sessionKey: key });
        sessionChecked = true;
        if (!isCurrent()) return;
      }
      const aborted = !!result && typeof result === 'object' && 'aborted' in result && result.aborted === true;
      const idle = sessionChecked && noMatchingRun(result);
      if (!aborted && !idle) {
        update(key, state => state.run?.requestedId !== requestId ? state : {
          ...state, run: { ...state.run, stopping: false }, activity: '仍在等待网关回复…',
          error: '网关尚未确认停止。可以稍后重试，或等待本次回复结束。',
        });
        return;
      }
      // Release only after an explicit stop/idle result, independently of history
      // availability. Preserve the local partial reply if the history read fails.
      const previous = stateRef.current[key];
      const next = update(key, state => state.run?.requestedId !== requestId ? state : {
        ...state, messages: state.stream ? [...state.messages, state.stream] : state.messages,
        stream: undefined, run: undefined, activity: undefined, completed: requestId,
        revision: state.revision + 1,
        error: aborted ? '已停止本次回复。' : '网关确认当前会话已无运行中的回复，正在刷新记录。',
      });
      afterRun(key, previous, next);
    } catch (error) {
      if (isCurrent()) update(key, state => state.run?.requestedId === requestId ? {
        ...state, run: { ...state.run, stopping: false }, activity: undefined, error: `停止确认失败：${errorText(error)}`,
      } : state);
    }
  };
  const send = async () => {
    const scope = generation.current;
    const key = selected;
    const current = stateRef.current[key] ?? emptySession();
    const message = current.draft.trim();
    if (!message || current.run || current.loading || statusRef.current.state !== 'connected') return;
    const id = crypto.randomUUID();
    update(key, state => beginRun(state, id, message));
    setLocalSessions(prior => [{ key, displayName: message.slice(0, 32), updatedAt: Date.now() }, ...prior.filter(session => session.key !== key)]);
    try {
      const result = await window.kuro.send({ sessionKey: key, message, idempotencyKey: id });
      if (scope !== generation.current) return;
      const previous = stateRef.current[key];
      const next = update(key, state => acknowledgeRun(state, id, result.runId, key));
      afterRun(key, previous, next);
      if (next.run?.stopping) await stopRun(key, id, scope);
    } catch (error) { if (scope === generation.current) update(key, state => failRun(state, id, `发送未确认：${errorText(error)} 请刷新记录后重试。`)); }
  };
  const stop = async () => {
    const scope = generation.current;
    const key = selected, run = stateRef.current[key]?.run;
    if (!run || run.stopping) return;
    update(key, state => state.run ? { ...state, error: undefined, run: { ...state.run, stopping: true },
      activity: run.ackPending ? '等待发送确认后停止…' : '正在请求停止…' } : state);
    // chat.send can still be preparing the run. Remember the intent and abort
    // after its acknowledgment, otherwise a premature abort can report idle.
    if (!run.ackPending) await stopRun(key, run.requestedId, scope);
  };
  const connectionAction = async (action: 'connect' | 'disconnect') => {
    if (!window.kuro || busy) return false;
    setBusy(true); setNotice('');
    try {
      if (action === 'connect') { const next = await window.kuro.connect(); statusRef.current = next; setStatus(next); }
      else await window.kuro.disconnect();
      return true;
    } catch (error) { setNotice(errorText(error)); return false; }
    finally { setBusy(false); }
  };
  const save = async (input: SettingsInput) => {
    if (!window.kuro || busy) return false;
    setBusy(true); setNotice('');
    settingsRequest.current++;
    try { const value = await window.kuro.saveSettings(input); settingsRequest.current++; applySettings(value, true); setNotice('设置已保存。点击连接，和库洛开始聊天吧。'); return true; }
    catch (error) { setNotice(errorText(error)); return false; }
    finally { setBusy(false); }
  };
  const importWsl = async (distro: string) => {
    if (!window.kuro || busy) return;
    setBusy(true); setNotice('');
    settingsRequest.current++;
    try { const value = await window.kuro.importWsl(distro); settingsRequest.current++; applySettings(value, true); setNotice('已从 WSL 导入配置。现在可以连接网关。'); }
    catch (error) { setNotice(errorText(error)); }
    finally { setBusy(false); }
  };
  const combined = [...sessions, ...localSessions.filter(local => !sessions.some(session => session.key === local.key))]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { selected, sessions: combined, sessionLoading, sessionError, states, current: states[selected] ?? emptySession(), status, settings, notice, busy,
    selectSession, createSession, refreshSessions, loadHistory, send, stop, connectionAction, save, importWsl, setNotice,
    setDraft: (draft: string) => update(selected, state => ({ ...state, draft })) };
}
