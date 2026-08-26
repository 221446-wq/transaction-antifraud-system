const { validateCreateTransactionInput } = require('../validators/transactionValidator');
const { serializeTransaction } = require('../serializers/transactionSerializer');
const transactionService = require('../services/transactionService');
const ValidationError = require('../errors/ValidationError');
const metrics = require('../metrics');

async function createTransaction(req, res) {
  const errors = await validateCreateTransactionInput(req.body);
  if (errors.length > 0) {
    throw new ValidationError(errors);
  }

  const { accountExternalIdDebit, accountExternalIdCredit, transferTypeId, value } = req.body;

  const transaction = await transactionService.createTransaction({
    accountExternalIdDebit,
    accountExternalIdCredit,
    transferTypeId,
    value,
  });

  metrics.transactionsCreatedTotal.inc();

  res.status(201).json(serializeTransaction(transaction));
}

async function getTransaction(req, res) {
  const { externalId } = req.params;
  const transaction = await transactionService.getTransactionByExternalId(externalId);
  res.status(200).json(serializeTransaction(transaction));
}

module.exports = { createTransaction, getTransaction };
