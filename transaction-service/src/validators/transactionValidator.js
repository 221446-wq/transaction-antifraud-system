const { validate: isUuid } = require('uuid');
const prisma = require('../db/prismaClient');

function isMissing(value) {
  return value === undefined || value === null || value === '';
}

/**
 * Valida el payload de creación de una transacción.
 * Devuelve la lista de errores encontrados (vacía si el payload es válido).
 */
async function validateCreateTransactionInput(body) {
  const errors = [];

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return [{ field: 'body', message: 'El cuerpo de la petición debe ser un objeto JSON.' }];
  }

  const { accountExternalIdDebit, accountExternalIdCredit, transferTypeId, value } = body;

  if (isMissing(accountExternalIdDebit)) {
    errors.push({ field: 'accountExternalIdDebit', message: 'Es un campo requerido.' });
  } else if (typeof accountExternalIdDebit !== 'string' || !isUuid(accountExternalIdDebit)) {
    errors.push({ field: 'accountExternalIdDebit', message: 'Debe ser un UUID válido.' });
  }

  if (isMissing(accountExternalIdCredit)) {
    errors.push({ field: 'accountExternalIdCredit', message: 'Es un campo requerido.' });
  } else if (typeof accountExternalIdCredit !== 'string' || !isUuid(accountExternalIdCredit)) {
    errors.push({ field: 'accountExternalIdCredit', message: 'Debe ser un UUID válido.' });
  }

  let transferTypeIdIsValidInteger = false;
  if (isMissing(transferTypeId)) {
    errors.push({ field: 'transferTypeId', message: 'Es un campo requerido.' });
  } else if (!Number.isInteger(transferTypeId)) {
    errors.push({ field: 'transferTypeId', message: 'Debe ser un número entero.' });
  } else {
    transferTypeIdIsValidInteger = true;
  }

  if (isMissing(value)) {
    errors.push({ field: 'value', message: 'Es un campo requerido.' });
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({ field: 'value', message: 'Debe ser un valor numérico.' });
  } else if (value <= 0) {
    errors.push({ field: 'value', message: 'Debe ser mayor a 0.' });
  }

  if (transferTypeIdIsValidInteger) {
    const transactionType = await prisma.transactionType.findUnique({
      where: { id: transferTypeId },
    });
    if (!transactionType) {
      errors.push({
        field: 'transferTypeId',
        message: `No existe un tipo de transacción con id ${transferTypeId}.`,
      });
    }
  }

  return errors;
}

module.exports = { validateCreateTransactionInput };
