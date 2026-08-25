const prisma = require('../db/prismaClient');
const { validateCreateTransactionInput } = require('../validators/transactionValidator');
const { serializeTransaction } = require('../serializers/transactionSerializer');
const { publishTransactionCreated } = require('../events/transactionCreatedPublisher');

async function createTransaction(req, res, next) {
  try {
    const errors = await validateCreateTransactionInput(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ errors });
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

    return res.status(201).json(serializeTransaction(transaction));
  } catch (err) {
    return next(err);
  }
}

module.exports = { createTransaction };
