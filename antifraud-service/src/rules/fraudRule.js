const FRAUD_THRESHOLD = 1000;

/**
 * Regla de negocio pura: no depende de Kafka ni de nada externo, y no tiene
 * efectos secundarios. Solo toma un valor y devuelve el status resultante,
 * lo que la hace trivial de probar de forma aislada.
 */
function evaluateFraudRule(value) {
  return value > FRAUD_THRESHOLD ? 'rejected' : 'approved';
}

module.exports = { evaluateFraudRule, FRAUD_THRESHOLD };
