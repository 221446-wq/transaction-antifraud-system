const { validate: isUuid } = require('uuid');
const prisma = require('../db/prismaClient');
const NotFoundError = require('../errors/NotFoundError');
const { enqueueTransactionCreated } = require('../outbox/outboxStore');

/**
 * Capa de servicio compartida por el controller REST
 * (controllers/transactionController.js) y los resolvers de GraphQL
 * (graphql/schema.js), para no duplicar la lógica de negocio (creación +
 * outbox, lectura + 404) entre las dos interfaces — ver CONTRACT.md.
 *
 * `createTransaction` inserta la transacción y encola su evento
 * `transaction.created` en la misma transacción de Postgres (patrón
 * Outbox): las dos cosas se confirman o fallan juntas, así que nunca queda
 * una transacción guardada sin su evento pendiente de publicar. Ver
 * DECISIONS.md.
 */
async function createTransaction({ accountExternalIdDebit, accountExternalIdCredit, transferTypeId, value }) {
  return prisma.$transaction(async (tx) => {
    const transaction = await tx.transaction.create({
      data: { accountExternalIdDebit, accountExternalIdCredit, transferTypeId, value },
      include: { transferType: true },
    });

    await enqueueTransactionCreated(tx, transaction);

    return transaction;
  });
}

async function getTransactionByExternalId(externalId) {
  const notFoundMessage = `No se encontró una transacción con id ${externalId}.`;

  // Un external_id con formato inválido nunca va a matchear ninguna fila;
  // se resuelve como 404 en vez de dejar que Postgres rechace el UUID mal
  // formado con un error de sintaxis (que sería un 500 confuso).
  if (!isUuid(externalId)) {
    throw new NotFoundError(notFoundMessage, 'externalId');
  }

  const transaction = await prisma.transaction.findUnique({
    where: { externalId },
    include: { transferType: true },
  });

  if (!transaction) {
    throw new NotFoundError(notFoundMessage, 'externalId');
  }

  return transaction;
}

module.exports = { createTransaction, getTransactionByExternalId };
