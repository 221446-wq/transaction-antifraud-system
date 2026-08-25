const prisma = require('../db/prismaClient');
const { validateCreateTransactionInput } = require('../validators/transactionValidator');
const { serializeTransaction } = require('../serializers/transactionSerializer');

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

    return res.status(201).json(serializeTransaction(transaction));
  } catch (err) {
    return next(err);
  }
}

module.exports = { createTransaction };
