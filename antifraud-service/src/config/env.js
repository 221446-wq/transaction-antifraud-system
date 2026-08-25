require('dotenv').config();

/**
 * Punto único de lectura de variables de entorno. El resto del código nunca
 * debe usar process.env directamente: siempre importa este módulo. Así, si
 * falta una variable obligatoria, el servicio falla al arrancar (fail-fast)
 * en vez de fallar más tarde en un punto confuso del código.
 */
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  }
  return value;
}

const env = {
  kafkaBrokers: required('KAFKA_BROKERS').split(','),
  kafkaClientId: process.env.KAFKA_CLIENT_ID || 'antifraud-service',
  kafkaConsumerGroupId: process.env.KAFKA_CONSUMER_GROUP_ID || 'antifraud-service',
};

module.exports = env;
