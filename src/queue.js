export function createQueue({ maxQueueDepth }) {
  const queues = new Map();  // key -> Array<{fn, resolve, reject}> (waiting items)
  const runCount = new Map(); // key -> number of items currently running (0 or 1)

  async function drain(key) {
    const q = queues.get(key);
    if (!q || q.length === 0) { runCount.set(key, 0); return; }
    const item = q.shift();
    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (e) {
      item.reject(e);
    } finally {
      drain(key);
    }
  }

  return {
    enqueue(key, fn) {
      if (!queues.has(key)) queues.set(key, []);
      const q = queues.get(key);
      const active = runCount.get(key) ?? 0;
      // reject only when the waiting queue is at capacity (running item does not count)
      if (q.length >= maxQueueDepth) {
        return Promise.reject(new Error(`queue full for key=${key}`));
      }
      return new Promise((resolve, reject) => {
        q.push({ fn, resolve, reject });
        if (active === 0) {
          runCount.set(key, 1);
          drain(key);
        }
      });
    },
    depth(key) {
      const waiting = queues.get(key)?.length ?? 0;
      const active = runCount.get(key) ?? 0;
      return waiting + active;
    }
  };
}
