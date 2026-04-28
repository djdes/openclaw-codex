import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/queue.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('createQueue: serializes runs per key', async () => {
  const q = createQueue({ maxQueueDepth: 10 });
  const order = [];
  const tasks = [
    q.enqueue('a', async () => { order.push('a1-start'); await sleep(20); order.push('a1-end'); }),
    q.enqueue('a', async () => { order.push('a2-start'); await sleep(10); order.push('a2-end'); }),
    q.enqueue('b', async () => { order.push('b1-start'); await sleep(15); order.push('b1-end'); })
  ];
  await Promise.all(tasks);
  // a1 must end before a2 starts; b1 may interleave with a
  const idxA1End = order.indexOf('a1-end');
  const idxA2Start = order.indexOf('a2-start');
  assert.ok(idxA1End < idxA2Start, `expected a1-end before a2-start, got: ${order.join(',')}`);
});

test('createQueue: rejects when depth exceeded', async () => {
  const q = createQueue({ maxQueueDepth: 2 });
  q.enqueue('x', () => sleep(50)); // running
  q.enqueue('x', () => sleep(50)); // queued #1
  q.enqueue('x', () => sleep(50)); // queued #2
  await assert.rejects(q.enqueue('x', () => sleep(10)), /queue full/);
});

test('createQueue: depth(key) returns current queue length', async () => {
  const q = createQueue({ maxQueueDepth: 5 });
  const p1 = q.enqueue('k', () => sleep(20));
  const p2 = q.enqueue('k', () => sleep(20));
  assert.equal(q.depth('k'), 2);
  await Promise.all([p1, p2]);
  assert.equal(q.depth('k'), 0);
});
