import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventLine, extractTextDelta, extractSessionId, extractTaskComplete, extractUsage } from '../src/codex.js';

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

test('extractTextDelta: returns text from codex 0.125 item.completed agent_message', () => {
  const ev = { type: 'item.completed', item: { id: 'item_6', type: 'agent_message', text: 'pong' } };
  assert.equal(extractTextDelta(ev), 'pong');
});

test('extractTextDelta: returns null for item.completed of non-agent_message type', () => {
  const ev = { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', exit_code: 0 } };
  assert.equal(extractTextDelta(ev), null);
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

test('extractSessionId: extracts from codex 0.125 thread.started event', () => {
  const ev = { type: 'thread.started', thread_id: '019dd3b0-5a1e-7d70-929d-2e13345879d0' };
  assert.equal(extractSessionId(ev), '019dd3b0-5a1e-7d70-929d-2e13345879d0');
});

test('extractTaskComplete: returns true for task_complete', () => {
  assert.equal(extractTaskComplete({ type: 'task_complete' }), true);
});

test('extractTaskComplete: returns true for codex 0.125 turn.completed', () => {
  assert.equal(extractTaskComplete({ type: 'turn.completed', usage: { input_tokens: 100 } }), true);
});

test('extractTaskComplete: returns false for other types', () => {
  assert.equal(extractTaskComplete({ type: 'agent_message_delta' }), false);
});

test('extractUsage: returns normalized usage from turn.completed', () => {
  const ev = {
    type: 'turn.completed',
    usage: { input_tokens: 23309, cached_input_tokens: 2432, output_tokens: 2, reasoning_output_tokens: 0 }
  };
  assert.deepEqual(extractUsage(ev), {
    input_tokens: 23309,
    cached_input_tokens: 2432,
    output_tokens: 2,
    reasoning_output_tokens: 0
  });
});

test('extractUsage: returns null for non-turn events', () => {
  assert.equal(extractUsage({ type: 'agent_message_delta', usage: { input_tokens: 1 } }), null);
});

test('extractUsage: returns null when usage is missing', () => {
  assert.equal(extractUsage({ type: 'turn.completed' }), null);
});

test('extractUsage: coerces missing usage fields to 0', () => {
  const ev = { type: 'turn.completed', usage: { input_tokens: 100 } };
  assert.deepEqual(extractUsage(ev), {
    input_tokens: 100,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0
  });
});

test('extractUsage: handles legacy task_complete shape', () => {
  const ev = { type: 'task_complete', usage: { input_tokens: 50, output_tokens: 25 } };
  assert.deepEqual(extractUsage(ev), {
    input_tokens: 50,
    cached_input_tokens: 0,
    output_tokens: 25,
    reasoning_output_tokens: 0
  });
});
