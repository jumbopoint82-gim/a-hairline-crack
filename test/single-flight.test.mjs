import test from 'node:test';
import assert from 'node:assert/strict';
import { SingleFlight } from '../worker/single-flight.ts';

test('shares one in-flight operation for the same key', async () => {
  const singleFlight = new SingleFlight();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const operation = async () => {
    calls += 1;
    await gate;
    return 'token';
  };

  const first = singleFlight.run('service@example.com', operation);
  const second = singleFlight.run('service@example.com', operation);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 'token');
  assert.equal(await second, 'token');
});

test('clears a failed operation so a later call can retry', async () => {
  const singleFlight = new SingleFlight();
  let calls = 0;

  await assert.rejects(
    singleFlight.run('service@example.com', async () => {
      calls += 1;
      throw new Error('temporary');
    }),
    /temporary/,
  );

  const value = await singleFlight.run('service@example.com', async () => {
    calls += 1;
    return 'fresh-token';
  });

  assert.equal(value, 'fresh-token');
  assert.equal(calls, 2);
});
