const { createYoga } = require('graphql-yoga');
const schema = require('./schema');

// graphql-yoga expone un request handler compatible con Express (se monta
// directo con `app.use('/graphql', yoga)` en app.js) sin necesitar un
// paquete de integración aparte.
const yoga = createYoga({
  schema,
  graphqlEndpoint: '/graphql',
  // El landing page interactivo (GraphiQL) queda habilitado a propósito:
  // es la forma más rápida de probar la mutation/query manualmente sin
  // instalar un cliente aparte.
  landingPage: true,
});

module.exports = yoga;
