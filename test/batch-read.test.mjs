import test from 'node:test';
import assert from 'node:assert/strict';
import { runPartialBatch } from '../worker/batch-read.ts';

test('reads unique keys concurrently and preserves requested order', async () => {
  const started = [];
  const result = await runPartialBatch([1, 2, 1, 3], async (key) => {
    started.push(key);
    await Promise.resolve();
    return `v${key}`;
  });

  assert.deepEqual(started, [1, 2, 3]);
  assert.deepEqual(result.requested, [1, 2, 3]);
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.items.map((item) => item.ok ? item.value : null), ['v1', 'v2', 'v3']);
});

test('keeps successful items when one read fails', async () => {
  const result = await runPartialBatch([1, 2, 3], async (key) => {
    if (key === 2) throw new Error('episode 2 unavailable');
    return `v${key}`;
  });

  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.items, [
    { key: 1, ok: true, value: 'v1' },
    { key: 2, ok: false, error: 'episode 2 unavailable' },
    { key: 3, ok: true, value: 'v3' },
  ]);
});
