const env = require('./config/env');

// Configuración inicial: valida que las variables de entorno de Kafka estén
// presentes y arma el cliente. La lógica de consumo/evaluación/publicación
// de eventos se agrega en tickets siguientes.
require('./kafka/kafkaClient');

console.log(
  `antifraud-service inicializado (clientId=${env.kafkaClientId}, brokers=${env.kafkaBrokers.join(',')})`,
);
