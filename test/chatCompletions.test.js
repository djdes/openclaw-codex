import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagesToPrompt, buildOpenAIResponse } from '../src/chatCompletions.js';

test('messagesToPrompt: includes system content under header', () => {
  const out = messagesToPrompt([
    { role: 'system', content: 'You are a YESBEAT manager.' },
    { role: 'user', content: 'Привет' }
  ]);
  assert.match(out, /# Системные инструкции/);
  assert.match(out, /You are a YESBEAT manager\./);
  assert.match(out, /\[клиент\]: Привет/);
  assert.match(out, /# Твой ответ/);
});

test('messagesToPrompt: maps assistant role to [ты ответил]', () => {
  const out = messagesToPrompt([
    { role: 'user', content: 'Сколько стоит подписка?' },
    { role: 'assistant', content: '500р/мес' },
    { role: 'user', content: 'Спасибо' }
  ]);
  assert.match(out, /\[клиент\]: Сколько стоит подписка\?/);
  assert.match(out, /\[ты ответил\]: 500р\/мес/);
  assert.match(out, /\[клиент\]: Спасибо/);
});

test('messagesToPrompt: handles only-user messages', () => {
  const out = messagesToPrompt([{ role: 'user', content: 'Тест' }]);
  assert.doesNotMatch(out, /# Системные инструкции/);
  assert.match(out, /\[клиент\]: Тест/);
});

test('buildOpenAIResponse: returns OpenAI-shaped object', () => {
  const r = buildOpenAIResponse({ model: 'm', content: 'hello', promptChars: 100, completionChars: 5 });
  assert.equal(r.object, 'chat.completion');
  assert.equal(r.model, 'm');
  assert.equal(r.choices.length, 1);
  assert.equal(r.choices[0].message.role, 'assistant');
  assert.equal(r.choices[0].message.content, 'hello');
  assert.equal(r.choices[0].finish_reason, 'stop');
  assert.equal(r.usage.prompt_tokens, 25);
  assert.equal(r.usage.completion_tokens, 2);
  assert.equal(r.usage.total_tokens, 27);
});
