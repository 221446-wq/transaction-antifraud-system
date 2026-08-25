const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateFraudRule } = require('../src/rules/fraudRule');

test('aprueba un valor menor al umbral', () => {
  assert.equal(evaluateFraudRule(500), 'approved');
});

test('aprueba un valor igual al umbral (1000 no es fraude)', () => {
  assert.equal(evaluateFraudRule(1000), 'approved');
});

test('rechaza un valor apenas mayor al umbral', () => {
  assert.equal(evaluateFraudRule(1000.01), 'rejected');
});

test('rechaza un valor muy por encima del umbral', () => {
  assert.equal(evaluateFraudRule(5000), 'rejected');
});
