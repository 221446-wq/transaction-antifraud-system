const env = require('./config/env');
const { startTransactionCreatedConsumer } = require('./events/transactionCreatedConsumer');

console.log(
  `antifraud-service inicializado (clientId=${env.kafkaClientId}, brokers=${env.kafkaBrokers.join(',')})`,
);

startTransactionCreatedConsumer().catch((err) => {
  console.error('El consumer de transaction.created se detuvo inesperadamente', err);
});
