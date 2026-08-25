function serializeTransaction(transaction) {
  return {
    transactionExternalId: transaction.externalId,
    transactionType: { name: transaction.transferType.name },
    transactionStatus: { name: transaction.status },
    value: Number(transaction.value),
    createdAt: transaction.createdAt,
  };
}

module.exports = { serializeTransaction };
