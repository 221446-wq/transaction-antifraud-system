const { createSchema } = require('graphql-yoga');
const { GraphQLError } = require('graphql');
const transactionService = require('../services/transactionService');
const { validateCreateTransactionInput } = require('../validators/transactionValidator');
const NotFoundError = require('../errors/NotFoundError');
const metrics = require('../metrics');

/**
 * Extensión opcional del enunciado: GraphQL "además de" REST, no en
 * reemplazo — ver CONTRACT.md. Reutiliza exactamente la misma capa de
 * servicio que el controller REST (transactionService.js), así que las dos
 * interfaces comparten la misma validación, la misma escritura outbox y la
 * misma regla de "no existe" — ninguna reimplementa lógica de negocio.
 */
const typeDefs = /* GraphQL */ `
  type TransactionTypeRef {
    name: String!
  }

  type TransactionStatusRef {
    name: String!
  }

  type Transaction {
    transactionExternalId: ID!
    transactionType: TransactionTypeRef!
    transactionStatus: TransactionStatusRef!
    value: Float!
    createdAt: String!
  }

  input CreateTransactionInput {
    accountExternalIdDebit: ID!
    accountExternalIdCredit: ID!
    transferTypeId: Int!
    value: Float!
  }

  type Query {
    """
    Busca una transacción por su identificador externo. Lanza un error con
    extensions.code = "NOT_FOUND" si no existe, igual que el 404 de la API
    REST.
    """
    transaction(externalId: ID!): Transaction!
  }

  type Mutation {
    """
    Crea una transacción. Lanza un error con extensions.code =
    "BAD_USER_INPUT" (y extensions.errors con la lista { field, message })
    si el input no pasa validación — mismas reglas que POST /transactions.
    """
    createTransaction(input: CreateTransactionInput!): Transaction!
  }
`;

function toGraphQLTransaction(transaction) {
  return {
    transactionExternalId: transaction.externalId,
    transactionType: { name: transaction.transferType.name },
    transactionStatus: { name: transaction.status },
    value: Number(transaction.value),
    createdAt: transaction.createdAt.toISOString(),
  };
}

const resolvers = {
  Query: {
    async transaction(_parent, { externalId }) {
      try {
        const transaction = await transactionService.getTransactionByExternalId(externalId);
        return toGraphQLTransaction(transaction);
      } catch (err) {
        if (err instanceof NotFoundError) {
          throw new GraphQLError(err.errors[0].message, { extensions: { code: 'NOT_FOUND' } });
        }
        throw err;
      }
    },
  },
  Mutation: {
    async createTransaction(_parent, { input }) {
      const errors = await validateCreateTransactionInput(input);
      if (errors.length > 0) {
        throw new GraphQLError('Datos de entrada inválidos.', {
          extensions: { code: 'BAD_USER_INPUT', errors },
        });
      }

      const transaction = await transactionService.createTransaction(input);
      metrics.transactionsCreatedTotal.inc();
      return toGraphQLTransaction(transaction);
    },
  },
};

module.exports = createSchema({ typeDefs, resolvers });
