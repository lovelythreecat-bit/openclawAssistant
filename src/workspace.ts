import type { ChatEvent, ChatMessage } from './types';
export interface Run { id: string; requestedId: string; text: string; ackPending: boolean; seq: number; buffered: ChatEvent[]; stopping?: boolean }
export interface SessionState { messages: ChatMessage[]; draft: string; loading: boolean; loaded: boolean; error?: string; stream?: ChatMessage; run?: Run; activity?: string; revision: number; completed?: string }
export const emptySession = (): SessionState => ({ messages: [], draft: '', loading: false, loaded: false, revision: 0 });
export function beginRun(state: SessionState, id: string, text: string): SessionState {
  if (state.run || state.loading) return state;
  return { ...state, draft: '', error: undefined, activity: undefined, stream: undefined, completed: undefined, loaded: true, revision: state.revision + 1,
    messages: [...state.messages, { role: 'user', content: text, id, timestamp: Date.now() }],
    run: { id, requestedId: id, text, ackPending: true, seq: -1, buffered: [] } };
}
export function applyChatEvent(state: SessionState, key: string, event: ChatEvent): SessionState {
  if (event.sessionKey !== key || !state.run) return state;
  const run = state.run;
  if (event.runId !== run.id && event.runId !== run.requestedId) {
    return run.ackPending ? { ...state, run: { ...run, buffered: [...run.buffered.slice(-49), event] } } : state;
  }
  // OpenClaw can flush the last delta and its terminal event with the same seq.
  // Deduplicate text updates, but still let that terminal event close the run.
  if (event.seq < run.seq || (event.seq === run.seq && event.state === 'delta')) return state;
  if (event.state === 'delta') return { ...state, stream: event.message ?? state.stream, run: { ...run, seq: event.seq }, activity: undefined };
  const message = event.message ?? state.stream;
  return { ...state, messages: message ? [...state.messages, message] : state.messages, stream: undefined, run: undefined, activity: undefined,
    revision: state.revision + 1, completed: run.requestedId,
    error: event.state === 'error' ? (event.errorMessage || '回复中断了，请刷新记录后重试。') : event.state === 'aborted' ? '已停止本次回复。' : undefined };
}
export function acknowledgeRun(state: SessionState, requestId: string, runId: string, key: string): SessionState {
  if (state.run?.requestedId !== requestId) return state;
  const buffered = state.run.buffered;
  let next: SessionState = { ...state, run: { ...state.run, id: runId, ackPending: false, buffered: [] } };
  for (const event of buffered) next = applyChatEvent(next, key, event);
  return next;
}
export function failRun(state: SessionState, id: string, error: string): SessionState {
  if (state.run?.requestedId !== id) return state;
  return { ...state, draft: state.draft || state.run.text, messages: state.stream ? [...state.messages, state.stream] : state.messages.filter(message => message.id !== id),
    run: undefined, stream: undefined, activity: undefined, error, revision: state.revision + 1 };
}
export function connectionLost(state: SessionState): SessionState {
  if (!state.run && !state.loading) return state;
  return { ...state, messages: state.stream ? [...state.messages, state.stream] : state.messages,
    draft: state.draft || (state.run?.ackPending ? state.run.text : ''), run: undefined, stream: undefined, loading: false, activity: undefined,
    revision: state.revision + 1, error: '连接已断开。重新连接后请刷新记录，确认这次消息是否已送达。' };
}
