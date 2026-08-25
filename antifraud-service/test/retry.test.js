const test = require('node:test');
const assert = require('node:assert/strict');
const { withRetry } = require('../src/utils/retry');

test('devuelve el resultado sin reintentar si la primera llamada funciona', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    return 'ok';
  }, { retries: 3, initialDelayMs: 5 });

  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('reintenta con backoff hasta que la función funciona', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) {
      throw new Error(`falla intento ${calls}`);
    }
    return 'ok';
  }, { retries: 3, initialDelayMs: 5 });

  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('agota los reintentos y relanza el último error', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => {
      calls += 1;
      throw new Error(`falla intento ${calls}`);
    }, { retries: 2, initialDelayMs: 5 }),
    /falla intento 3/,
  );

  // 1 intento inicial + 2 reintentos = 3 llamadas.
  assert.equal(calls, 3);
});
