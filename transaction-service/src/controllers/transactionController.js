const { validate: isUuid } = require('uuid');
const prisma = require('../db/prismaClient');
const { validateCreateTransactionInput } = require('../validators/transactionValidator');
const { serializeTransaction } = require('../serializers/transactionSerializer');
const { publishTransactionCreated } = require('../events/transactionCreatedPublisher');
const ValidationError = require('../errors/ValidationError');
const NotFoundError = require('../errors/NotFoundError');

async function createTransaction(req, res) {
  const errors = await validateCreateTransactionInput(req.body);
  if (errors.length > 0) {
    throw new ValidationError(errors);
  }

  const { accountExternalIdDebit, accountExternalIdCredit, transferTypeId, value } = req.body;

  const transaction = await prisma.transaction.create({
    data: {
      accountExternalIdDebit,
      accountExternalIdCredit,
      transferTypeId,
      value,
    },
    include: { transferType: true },
  });

  try {
    await publishTransactionCreated(transaction);
  } catch (publishError) {
    // La transacción ya quedó guardada en `pending`; un fallo al publicar
    // no debe deshacerla ni impedir la respuesta al cliente. Queda
    // registrada para que se pueda reprocesar o investigar aparte.
    console.error('No se pudo publicar el evento transaction.created', {
      transactionExternalId: transaction.externalId,
      error: publishError,
    });
  }

  res.status(201).json(serializeTransaction(transaction));
}

async function getTransaction(req, res) {
  const { externalId } = req.params;
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

  res.status(200).json(serializeTransaction(transaction));
}

module.exports = { createTransaction, getTransaction };
