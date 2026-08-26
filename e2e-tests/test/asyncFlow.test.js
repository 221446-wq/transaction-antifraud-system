/**
 * Prueba end-to-end del flujo asíncrono completo, usando los dos servicios
 * reales (cada uno como proceso hijo, con su propio .env) y Kafka real (no
 * hay stubs de red acá, a propósito: el ticket pide comunicación real).
 *
 * Prerrequisitos para correrla (no los levanta esta prueba):
 *   - Kafka accesible en localhost:9092 (docker-compose up -d kafka zookeeper).
 *   - Postgres accesible según transaction-service/.env, con las migraciones
 *     de Prisma ya aplicadas (incluye el tipo "transfer" sembrado).
 *   - `npm install` corrido en transaction-service/, antifraud-service/ y
 *     este propio e2e-tests/.
 *
 * Corre con: npm test (desde e2e-tests/).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Kafka } = require('kafkajs');
const { Client: PgClient } = require('pg');

const { sleep, waitForCondition } = require('./support/wait');
const {
  TRANSACTION_SERVICE_DIR,
  ANTIFRAUD_SERVICE_DIR,
  spawnService,
  waitForHealth,
} = require('./support/services');

const TRANSACTION_SERVICE_URL = 'http://localhost:3000';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/transactions_db';

let transactionServiceProcess;
let antifraudServiceProcess;
let spyConsumer;
let testProducer;
let pgClient;

const receivedCreatedEvents = [];
const receivedDecisionEvents = [];
const receivedDlqEvents = [];
const createdExternalIds = [];

before(async () => {
  transactionServiceProcess = spawnService(TRANSACTION_SERVICE_DIR, 'transaction-service');
  antifraudServiceProcess = spawnService(ANTIFRAUD_SERVICE_DIR, 'antifraud-service');

  await waitForHealth(`${TRANSACTION_SERVICE_URL}/health`, 20000);

  // "Espía" de Kafka independiente de ambos servicios, con su propio
  // consumer group, para verificar de forma directa qué se publicó en cada
  // tópico (no solo inferirlo del estado final en la base de datos).
  const kafka = new Kafka({ clientId: 'e2e-spy', brokers: ['localhost:9092'] });
  spyConsumer = kafka.consumer({ groupId: `e2e-spy-${Date.now()}` });
  await spyConsumer.connect();
  await spyConsumer.subscribe({
    topics: ['transaction.created', 'transaction.fraud-decision', 'transaction.fraud-decision.dlq'],
    fromBeginning: false,
  });
  spyConsumer.run({
    eachMessage: async ({ topic, message }) => {
      const event = JSON.parse(message.value.toString('utf8'));
      if (topic === 'transaction.created') {
        receivedCreatedEvents.push(event);
      } else if (topic === 'transaction.fraud-decision') {
        receivedDecisionEvents.push(event);
      } else if (topic === 'transaction.fraud-decision.dlq') {
        receivedDlqEvents.push(event);
      }
    },
  });

  // Productor propio del test, para poder republicar un evento "a mano"
  // (simular una redelivery real de Kafka) en el test de duplicados.
  testProducer = kafka.producer();
  await testProducer.connect();

  pgClient = new PgClient({ connectionString: DATABASE_URL });
  await pgClient.connect();

  // Margen para que el espía y los consumers reales de ambos servicios
  // terminen de unirse a sus grupos (grupo nuevo + fromBeginning:false
  // arranca en "latest": si publicamos antes de que se una, se pierde el
  // mensaje).
  await sleep(5000);
});

after(async () => {
  if (createdExternalIds.length > 0 && pgClient) {
    await pgClient.query('DELETE FROM outbox_events WHERE aggregate_id = ANY($1)', [createdExternalIds]);
    await pgClient.query('DELETE FROM transactions WHERE external_id = ANY($1)', [createdExternalIds]);
  }
  if (pgClient) await pgClient.end();
  if (testProducer) await testProducer.disconnect();
  if (spyConsumer) await spyConsumer.disconnect();
  if (transactionServiceProcess) transactionServiceProcess.kill();
  if (antifraudServiceProcess) antifraudServiceProcess.kill();
});

async function createTransaction(value) {
  const res = await fetch(`${TRANSACTION_SERVICE_URL}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountExternalIdDebit: randomUUID(),
      accountExternalIdCredit: randomUUID(),
      transferTypeId: 1, // "transfer", sembrado por la migración inicial
      value,
    }),
  });

  assert.equal(res.status, 201, `esperaba 201 al crear, recibí ${res.status}`);
  const body = await res.json();
  return body;
}

async function fetchTransaction(transactionExternalId) {
  const res = await fetch(`${TRANSACTION_SERVICE_URL}/transactions/${transactionExternalId}`);
  assert.equal(res.status, 200);
  return res.json();
}

async function runFullFlow({ value, expectedStatus }) {
  // 1) POST /transactions y verificar estado inicial "pending".
  const created = await createTransaction(value);
  createdExternalIds.push(created.transactionExternalId);
  assert.equal(created.transactionStatus.name, 'pending');
  const { transactionExternalId } = created;

  // 2) Verificar la publicación real de transaction.created.
  const createdEvent = await waitForCondition(
    () => receivedCreatedEvents.find((e) => e.data.transactionExternalId === transactionExternalId),
    10000,
  );
  assert.equal(createdEvent.eventType, 'transaction.created');
  assert.equal(createdEvent.data.value, value);

  // 3) Dejar que antifraud-service procese el evento y publique su
  //    decisión real (transaction.fraud-decision).
  const decisionEvent = await waitForCondition(
    () => receivedDecisionEvents.find((e) => e.data.transactionExternalId === transactionExternalId),
    15000,
  );
  assert.equal(decisionEvent.eventType, 'transaction.fraud-decision');
  assert.equal(decisionEvent.data.status, expectedStatus);

  // 4) Verificar que transaction-service consumió esa decisión y actualizó
  //    el estado final en su propia base de datos.
  const finalTransaction = await waitForCondition(async () => {
    const tx = await fetchTransaction(transactionExternalId);
    return tx.transactionStatus.name !== 'pending' ? tx : null;
  }, 15000);
  assert.equal(finalTransaction.transactionStatus.name, expectedStatus);
  assert.equal(finalTransaction.value, value);
}

test('flujo completo: una transacción de bajo monto termina en approved', async () => {
  await runFullFlow({ value: 500, expectedStatus: 'approved' });
});

test('flujo completo: una transacción de monto alto termina en rejected', async () => {
  await runFullFlow({ value: 1500, expectedStatus: 'rejected' });
});

test('duplicados: republicar el mismo transaction.fraud-decision no cambia el resultado ni tumba el servicio', async () => {
  // Dejamos que el flujo real se resuelva una vez, de punta a punta.
  const created = await createTransaction(300);
  createdExternalIds.push(created.transactionExternalId);
  const { transactionExternalId } = created;

  const decisionEvent = await waitForCondition(
    () => receivedDecisionEvents.find((e) => e.data.transactionExternalId === transactionExternalId),
    15000,
  );
  assert.equal(decisionEvent.data.status, 'approved');

  await waitForCondition(async () => {
    const tx = await fetchTransaction(transactionExternalId);
    return tx.transactionStatus.name !== 'pending' ? tx : null;
  }, 15000);

  const resolved = await fetchTransaction(transactionExternalId);
  assert.equal(resolved.transactionStatus.name, 'approved');

  // Ahora republicamos EL MISMO evento (mismos eventId/bytes) directamente
  // al tópico real, simulando una redelivery genuina de Kafka (at-least-
  // once) en vez de simularla en memoria como en el test de idempotencia
  // a nivel de servicio.
  await testProducer.send({
    topic: 'transaction.fraud-decision',
    messages: [{ key: transactionExternalId, value: JSON.stringify(decisionEvent) }],
  });

  // Le damos margen al consumer real de transaction-service para
  // procesarlo, y confirmamos que el servicio sigue vivo (no se cayó por
  // el duplicado) y que el estado no cambió.
  await sleep(3000);
  await waitForHealth(`${TRANSACTION_SERVICE_URL}/health`, 5000);

  const finalTransaction = await fetchTransaction(transactionExternalId);
  assert.equal(finalTransaction.transactionStatus.name, 'approved');
});

test('DLQ: un transaction.fraud-decision mal formado se descarta a transaction.fraud-decision.dlq sin tumbar el servicio', async () => {
  // Un mensaje que no cumple el contrato (falta transactionExternalId) nunca
  // debería llegar en un sistema sano, pero at-least-once + productores mal
  // implementados hacen que "puede pasar" — ver CONTRACT.md y
  // DECISIONS.md, "Observabilidad"/DLQ.
  const malformedEvent = {
    eventId: randomUUID(),
    eventType: 'transaction.fraud-decision',
    occurredAt: new Date().toISOString(),
    data: { status: 'approved' }, // sin transactionExternalId
  };

  await testProducer.send({
    topic: 'transaction.fraud-decision',
    messages: [{ key: 'malformed-e2e-test', value: JSON.stringify(malformedEvent) }],
  });

  const dlqEvent = await waitForCondition(
    () => receivedDlqEvents.find((e) => e.data.rawValue?.includes(malformedEvent.eventId)),
    15000,
  );
  assert.equal(dlqEvent.data.originalTopic, 'transaction.fraud-decision');
  assert.equal(dlqEvent.data.reason, 'invalid_event');

  // El servicio sigue vivo y atendiendo requests después de descartar el
  // mensaje inválido.
  await waitForHealth(`${TRANSACTION_SERVICE_URL}/health`, 5000);
});
