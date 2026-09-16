import test from 'node:test';
import assert from 'node:assert/strict';

import { createReadReliableFetch } from '../worker/read-reliability.ts';

test('retries transient GET responses and returns the first success', async () => {
  let attempts = 0;
  const sleeps = [];
  const nativeFetch = async () => {
    attempts += 1;
    return attempts < 3
      ? new Response('temporary', { status: 503 })
      : new Response('ok', { status: 200 });
  };
  const reliableFetch = createReadReliableFetch(nativeFetch, {
    maxAttempts: 3,
    timeoutMs: 1000,
    baseDelayMs: 1,
    maxDelayMs: 10,
    sleep: async (ms) => sleeps.push(ms),
  });

  const response = await reliableFetch('https://example.com/data');

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1, 2]);
});

test('does not retry permanent authorization failures', async () => {
  let attempts = 0;
  const reliableFetch = createReadReliableFetch(async () => {
    attempts += 1;
    return new Response('forbidden', { status: 403 });
  }, { sleep: async () => {} });

  const response = await reliableFetch('https://example.com/data');

  assert.equal(response.status, 403);
  assert.equal(attempts, 1);
});

test('retries the Google OAuth token exchange because duplicate token minting is safe', async () => {
  let attempts = 0;
  const reliableFetch = createReadReliableFetch(async () => {
    attempts += 1;
    return attempts === 1
      ? new Response('temporary', { status: 500 })
      : new Response('{"access_token":"token"}', { status: 200 });
  }, { baseDelayMs: 0, sleep: async () => {} });

  const response = await reliableFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'x' }),
  });

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test('never retries write requests', async () => {
  let attempts = 0;
  const reliableFetch = createReadReliableFetch(async () => {
    attempts += 1;
    return new Response('temporary', { status: 503 });
  }, { baseDelayMs: 0, sleep: async () => {} });

  const response = await reliableFetch(
    'https://docs.googleapis.com/v1/documents/doc:batchUpdate',
    { method: 'POST', body: '{}' },
  );

  assert.equal(response.status, 503);
  assert.equal(attempts, 1);
});

test('retries transient network errors for reads', async () => {
  let attempts = 0;
  const reliableFetch = createReadReliableFetch(async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('network reset');
    return new Response('ok', { status: 200 });
  }, { baseDelayMs: 0, sleep: async () => {} });

  const response = await reliableFetch('https://example.com/data');

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test('times out stalled reads and retries them', async () => {
  let attempts = 0;
  const reliableFetch = createReadReliableFetch(
    (_input, init = {}) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    },
    { maxAttempts: 2, timeoutMs: 5, baseDelayMs: 0, sleep: async () => {} },
  );

  await assert.rejects(
    reliableFetch('https://example.com/stalled'),
    /timed out|timeout|abort/i,
  );
  assert.equal(attempts, 2);
});
