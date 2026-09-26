import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySession, beginRun, applyChatEvent, acknowledgeRun, failRun, connectionLost } from '../src/workspace.js';
import type { ChatEvent } from '../src/types.js';

const event = (changes: Partial<ChatEvent> = {}): ChatEvent => ({ sessionKey: 'a', runId: 'run-1', seq: 1, state: 'delta', message: { role: 'assistant', content: '你好' }, ...changes });
test('stream snapshots replace text without duplicating prior deltas', () => {
  let state = beginRun(emptySession(), 'run-1', 'hello');
  state = applyChatEvent(state, 'a', event());
  state = applyChatEvent(state, 'a', event({ seq: 2, message: {role: 'assistant', content: '你好，世界'} }));
  assert.equal(state.stream?.content, '你好，世界');
  assert.equal(state.messages.length, 1);
});
test('unrelated sessions and stale runs cannot change the stream', () => {
  const state = acknowledgeRun(beginRun(emptySession(), 'run-1', 'hello'), 'run-1', 'run-1', 'a');
  assert.equal(applyChatEvent(state, 'a', event({ sessionKey: 'b' })), state);
  assert.equal(applyChatEvent(state, 'a', event({ runId: 'old' })), state);
  const next = applyChatEvent(state, 'a', event({ seq: 3 }));
  assert.equal(applyChatEvent(next, 'a', event({seq: 2})), next);
});
test('events received before RPC acknowledgment reconcile the returned run ID', () => {
  let state = beginRun(emptySession(), 'request-id', 'hello');
  state = applyChatEvent(state, 'a', event({ state: 'final' }));
  assert.ok(state.run);
  state = acknowledgeRun(state, 'request-id', 'run-1', 'a');
  assert.equal(state.run, undefined);
  assert.deepEqual(state.messages.map(x => x.content), ['hello', '你好']);
});
test('final snapshot appears once and late acknowledgment does not restart a run', () => {
  let state = beginRun(emptySession(), 'run-1', 'hello');
  state = applyChatEvent(state, 'a', event());
  state = applyChatEvent(state, 'a', event({state: 'final', seq: 2}));
  state = acknowledgeRun(state, 'run-1', 'run-1', 'a');
  assert.equal(state.messages.length, 2);
  assert.equal(state.stream, undefined);
  assert.equal(state.run, undefined);
});
for (const terminal of ['final', 'error', 'aborted'] as const) {
  test(`${terminal} closes a run at the same sequence as its final buffered delta`, () => {
    let state = acknowledgeRun(beginRun(emptySession(), 'run-1', 'hello'), 'run-1', 'run-1', 'a');
    const delta = event({ seq: 7 });
    state = applyChatEvent(state, 'a', delta);
    assert.equal(applyChatEvent(state, 'a', delta), state, 'duplicate deltas remain ignored');
    assert.equal(applyChatEvent(state, 'a', event({ seq: 6, state: terminal })), state, 'older terminal events remain ignored');
    const done = event({ seq: 7, state: terminal, message: undefined, errorMessage: 'fixture failure' });
    state = applyChatEvent(state, 'a', done);
    assert.equal(state.run, undefined);
    assert.equal(state.stream, undefined);
    assert.equal(state.activity, undefined);
    assert.equal(state.completed, 'run-1');
    assert.deepEqual(state.messages.map(message => message.content), ['hello', '你好']);
    assert.equal(state.error, terminal === 'error' ? 'fixture failure' : terminal === 'aborted' ? '已停止本次回复。' : undefined);
    assert.equal(applyChatEvent(state, 'a', done), state, 'duplicate terminal cannot append another reply');
  });
}
test('a same-sequence final buffered before send acknowledgment still closes the acknowledged run', () => {
  let state = beginRun(emptySession(), 'request-id', 'hello');
  state = applyChatEvent(state, 'a', event({ seq: 7 }));
  state = applyChatEvent(state, 'a', event({ seq: 7, state: 'final' }));
  state = acknowledgeRun(state, 'request-id', 'run-1', 'a');
  assert.equal(state.run, undefined);
  assert.equal(state.stream, undefined);
  assert.deepEqual(state.messages.map(message => message.content), ['hello', '你好']);
});
test('failed send restores draft and removes unsent optimistic message', () => {
  const state = failRun(beginRun(emptySession(), 'run-1', 'hello'), 'run-1', 'offline');
  assert.equal(state.draft, 'hello');
  assert.equal(state.messages.length, 0);
  assert.equal(state.run, undefined);
  assert.equal(state.error, 'offline');
});
test('connection loss ends pending state, preserves partial response and recovery text', () => {
  const state = connectionLost(applyChatEvent(beginRun(emptySession(), 'run-1', 'hello'), 'a', event()));
  assert.equal(state.run, undefined);
  assert.equal(state.loading, false);
  assert.equal(state.messages[1].content, '你好');
  assert.ok(state.error);
});
test('a run cannot be submitted twice and failed old requests do not affect a new run', () => {
  const state = beginRun(emptySession(), 'run-1', 'hello');
  assert.equal(beginRun(state, 'run-2', 'double'), state);
  assert.equal(failRun(state, 'old', 'failure'), state);
});
test('an RPC failure after streamed output retains the already observed exchange', () => {
  const state = failRun(applyChatEvent(beginRun(emptySession(), 'run-1', 'hello'), 'a', event()), 'run-1', 'ack timeout');
  assert.deepEqual(state.messages.map(message => message.content), ['hello', '你好']);
  assert.equal(state.draft, 'hello');
  assert.equal(state.run, undefined);
});
