const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateFraudRule, FRAUD_THRESHOLD } = require('../src/rules/fraudRule');

test('aprueba un valor menor al umbral', () => {
  assert.equal(evaluateFraudRule(500), 'approved');
});

test('value = 1000 devuelve approved (el umbral en sí no es fraude)', () => {
  assert.equal(evaluateFraudRule(1000), 'approved');
  assert.equal(evaluateFraudRule(FRAUD_THRESHOLD), 'approved');
});

test('value = 1001 devuelve rejected', () => {
  assert.equal(evaluateFraudRule(1001), 'rejected');
});

test('rechaza un valor apenas mayor al umbral', () => {
  assert.equal(evaluateFraudRule(1000.01), 'rejected');
});

test('rechaza un valor muy por encima del umbral', () => {
  assert.equal(evaluateFraudRule(5000), 'rejected');
});

// La función no valida rangos (eso es responsabilidad de quien arma el
// evento, ver transactionCreatedConsumer#parseEvent), así que documentamos
// cómo se comporta igual con estos bordes en vez de asumir que "no deberían
// llegar nunca".
test('value = 0 devuelve approved', () => {
  assert.equal(evaluateFraudRule(0), 'approved');
});

test('un valor negativo devuelve approved (no supera el umbral)', () => {
  assert.equal(evaluateFraudRule(-50), 'approved');
});
