const test = require('node:test');
const assert = require('node:assert/strict');
const { HostRateLimiter } = require('../src/http/hostRateLimiter');

test('la primera request a un host no espera', async () => {
  const limiter = new HostRateLimiter(200);
  const start = Date.now();
  await limiter.waitForTurn('example.com');
  assert.ok(Date.now() - start < 50);
});

test('una segunda request al mismo host antes del intervalo mínimo espera lo que falta', async () => {
  const limiter = new HostRateLimiter(150);
  await limiter.waitForTurn('example.com');

  const start = Date.now();
  await limiter.waitForTurn('example.com');
  const elapsed = Date.now() - start;

  assert.ok(elapsed >= 100, `esperaba que esperara ~150ms, esperó ${elapsed}ms`);
});

test('hosts distintos no se bloquean entre sí', async () => {
  const limiter = new HostRateLimiter(500);
  await limiter.waitForTurn('a.example.com');

  const start = Date.now();
  await limiter.waitForTurn('b.example.com');
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 50, `un host distinto no debería esperar por otro, esperó ${elapsed}ms`);
});
