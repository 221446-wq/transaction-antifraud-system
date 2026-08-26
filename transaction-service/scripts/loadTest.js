#!/usr/bin/env node
/**
 * Prueba de carga liviana para la extensión opcional "alto volumen de
 * lecturas y escrituras simultáneas" (ver README.md y docs/HIGH_VOLUME.md).
 * No reemplaza un benchmark serio con datos de producción reales — es una
 * forma rápida y reproducible de ver el comportamiento del servicio bajo
 * concurrencia sin instalar herramientas externas (usa `autocannon`, ya en
 * devDependencies).
 *
 * Requiere transaction-service corriendo (con Postgres accesible; Kafka es
 * opcional para esto, ya que el outbox absorbe su ausencia). Kafka no hace
 * falta que esté arriba para que esta prueba tenga sentido: mide el camino
 * síncrono (HTTP + Postgres), que es lo que percibe el cliente.
 *
 * Uso:
 *   npm run load-test
 *   LOAD_TEST_CONNECTIONS=200 LOAD_TEST_DURATION=30 npm run load-test
 */
const { randomUUID } = require('node:crypto');
const autocannon = require('autocannon');

const BASE_URL = process.env.LOAD_TEST_URL || 'http://localhost:3000';
const CONNECTIONS = Number(process.env.LOAD_TEST_CONNECTIONS) || 50;
const DURATION = Number(process.env.LOAD_TEST_DURATION) || 15;
const VALID_TRANSFER_TYPE_ID = 1; // "transfer", sembrado por la migración inicial

function randomTransactionPayload() {
  // ~10% de los montos superan el umbral de fraude (1000), para que la
  // prueba también ejercite el camino "rejected", no solo "approved".
  const value = Math.random() < 0.1
    ? Math.round(1001 + Math.random() * 5000)
    : Math.round(1 + Math.random() * 999);

  return JSON.stringify({
    accountExternalIdDebit: randomUUID(),
    accountExternalIdCredit: randomUUID(),
    transferTypeId: VALID_TRANSFER_TYPE_ID,
    value,
  });
}

function runAutocannon(options) {
  return new Promise((resolve, reject) => {
    const instance = autocannon(options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    autocannon.track(instance, { renderProgressBar: true });
  });
}

function summarize(label, result) {
  console.log(`\n--- ${label} ---`);
  console.log(`Requests/seg (promedio): ${result.requests.average}`);
  console.log(`Latencia p50/p99 (ms):   ${result.latency.p50} / ${result.latency.p99}`);
  console.log(`Respuestas 2xx / no-2xx: ${result['2xx']} / ${result.non2xx}`);
  console.log(`Errores de conexión:     ${result.errors}`);
  console.log(`Timeouts:                ${result.timeouts}`);
}

async function seedTransactionIds(count) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    // Secuencial y a propósito: es solo el seed de datos para la prueba de
    // lectura, no la carga que se está midiendo.
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${BASE_URL}/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: randomTransactionPayload(),
    });
    // eslint-disable-next-line no-await-in-loop
    const body = await res.json();
    if (res.status === 201) ids.push(body.transactionExternalId);
  }
  return ids;
}

async function main() {
  console.log(`Objetivo: ${BASE_URL} | conexiones: ${CONNECTIONS} | duración: ${DURATION}s por fase`);

  console.log('\nSembrando transacciones para la fase de lectura...');
  const seedIds = await seedTransactionIds(30);
  if (seedIds.length === 0) {
    throw new Error(`No se pudo sembrar ninguna transacción — ¿está corriendo ${BASE_URL}?`);
  }

  const writeResult = await runAutocannon({
    url: `${BASE_URL}/transactions`,
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        setupRequest: (req) => ({ ...req, body: randomTransactionPayload() }),
      },
    ],
  });
  summarize(`Escritura: POST /transactions (${CONNECTIONS} conexiones, ${DURATION}s)`, writeResult);

  const readResult = await runAutocannon({
    url: BASE_URL,
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [
      {
        method: 'GET',
        setupRequest: (req) => ({ ...req, path: `/transactions/${seedIds[Math.floor(Math.random() * seedIds.length)]}` }),
      },
    ],
  });
  summarize(`Lectura: GET /transactions/:externalId (${CONNECTIONS} conexiones, ${DURATION}s)`, readResult);

  const mixedResult = await runAutocannon({
    url: BASE_URL,
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [
      {
        method: 'POST',
        path: '/transactions',
        headers: { 'content-type': 'application/json' },
        setupRequest: (req) => ({ ...req, body: randomTransactionPayload() }),
      },
      {
        method: 'GET',
        setupRequest: (req) => ({ ...req, path: `/transactions/${seedIds[Math.floor(Math.random() * seedIds.length)]}` }),
      },
    ],
  });
  summarize(`Mixta: lecturas + escrituras simultáneas (${CONNECTIONS} conexiones, ${DURATION}s)`, mixedResult);

  console.log('\nVer docs/HIGH_VOLUME.md para cómo interpretar estos números y qué palancas ajustar.');
}

main().catch((err) => {
  console.error('La prueba de carga falló:', err.message);
  process.exit(1);
});
