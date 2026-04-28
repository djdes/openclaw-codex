import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventLine, extractTextDelta, extractSessionId, extractTaskComplete } from '../src/codex.js';

test('parseEventLine: returns parsed JSON for valid line', () => {
  const line = '{"type":"agent_message_delta","delta":"hello"}';
  const ev = parseEventLine(line);
  assert.equal(ev.type, 'agent_message_delta');
  assert.equal(ev.delta, 'hello');
});

test('parseEventLine: returns null for non-JSON line', () => {
  assert.equal(parseEventLine('not json'), null);
});

test('parseEventLine: returns null for empty line', () => {
  assert.equal(parseEventLine(''), null);
  assert.equal(parseEventLine('   '), null);
});

test('extractTextDelta: returns text from agent_message_delta', () => {
  assert.equal(extractTextDelta({ type: 'agent_message_delta', delta: 'foo' }), 'foo');
});

test('extractTextDelta: returns text from item.text variant', () => {
  // Defensive: codex may use either flat delta or nested item; support both
  assert.equal(extractTextDelta({ type: 'agent_message_delta', item: { text: 'bar' } }), 'bar');
});

test('extractTextDelta: returns null for non-delta event', () => {
  assert.equal(extractTextDelta({ type: 'tool_call_begin' }), null);
});

test('extractSessionId: extracts from session_started event', () => {
  assert.equal(extractSessionId({ type: 'session_started', session_id: 'abc-123' }), 'abc-123');
});

test('extractSessionId: extracts from sessionId camelCase variant', () => {
  assert.equal(extractSessionId({ type: 'session_started', sessionId: 'xyz' }), 'xyz');
});

test('extractSessionId: returns null when not present', () => {
  assert.equal(extractSessionId({ type: 'agent_message_delta' }), null);
});

test('extractTaskComplete: returns true for task_complete', () => {
  assert.equal(extractTaskComplete({ type: 'task_complete' }), true);
});

test('extractTaskComplete: returns false for other types', () => {
  assert.equal(extractTaskComplete({ type: 'agent_message_delta' }), false);
});
