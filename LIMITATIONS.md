# Limitaciones conocidas

Este documento es un inventario honesto de lo que **no** está hecho, lo que
se simplificó a propósito, y lo que se sabe que falta probar — para que
nadie lo descubra por sorpresa. Las decisiones de diseño de lo que sí se
implementó están en [DECISIONS.md](./DECISIONS.md).

## Funcionalidades no implementadas

- **Autenticación/autorización.** Ningún endpoint HTTP de ninguno de los
  tres servicios (`POST /transactions`, `GET /transactions/:externalId`,
  `POST /graphql`, `GET /metrics`, `GET /reference-rates*`) requiere
  autenticación — cualquiera que le pegue al puerto puede usarlos. No hay
  API keys, JWT, ni ningún control de acceso. `GET /metrics` expuesto sin
  protección es además una fuga de información operacional menor (tasas de
  éxito, volumen) en un despliegue real; ahí normalmente se resuelve a nivel
  de red (el scraper de Prometheus en la misma VPC, no expuesto a internet),
  no con auth en la aplicación.
- **Rate limiting.** Ningún endpoint tiene límite de tasa.
- **Listado/paginación de transacciones.** Solo existe consulta por
  `external_id` individual, tanto en REST como en GraphQL; no hay un
  `GET /transactions` ni una `query transactions` con filtros o paginación.
- **Idempotencia en la *creación*.** La idempotencia que sí está garantizada
  (ver DECISIONS.md) es la del *consumo* de `transaction.fraud-decision`.
  `POST /transactions` (y la mutation de GraphQL equivalente) no tienen
  protección contra duplicados del lado del cliente: si un cliente reintenta
  una creación (por un timeout, por ejemplo) sin mandar ningún identificador
  de idempotencia, el resultado son dos transacciones distintas, cada una
  con su propio `external_id`.
- **Reprocesamiento automático de la DLQ.** Los tópicos `*.dlq` (ver
  CONTRACT.md) son de solo inspección: nada los consume ni reintenta
  republicar en el tópico original. Reprocesar un mensaje ahí hoy es un paso
  manual.
- **El relay del outbox es una única instancia**, corriendo dentro del
  mismo proceso que el servidor HTTP de `transaction-service` (ver
  DECISIONS.md, "Patrón Outbox"). No hay forma de escalarlo por separado del
  resto del servicio sin extraerlo a su propio proceso — no implementado.
- **Tracing distribuido (OpenTelemetry/Jaeger).** Se optó por logs
  correlacionados por `transactionExternalId` en vez de un SDK de tracing
  completo — ver DECISIONS.md, "Observabilidad", para el razonamiento
  (no hay un collector en `docker-compose.yml` donde ver los traces).
- **CI/CD.** No hay ningún pipeline (GitHub Actions o similar) que corra las
  cuatro suites de test automáticamente en cada cambio.

## Simplificaciones realizadas

- **Cuentas no validadas.** `accountExternalIdDebit`/`accountExternalIdCredit`
  solo se validan como UUID con formato correcto — no se verifica que la
  cuenta exista en ningún lado, ni que sean distintas entre sí (una
  transacción con la misma cuenta de débito y de crédito es válida hoy).
- **`transferTypeId` es solo un nombre.** Más allá de existir, el tipo de
  transferencia no afecta ninguna regla de negocio (ni la de fraude ni
  ninguna otra) — es puramente descriptivo.
- **Parámetros de reintento fijos.** Los backoffs de Kafka (conexión,
  reintentos de publish) y del retry de `antifraud-service` están
  hardcodeados en el código, no son configurables por variable de entorno.
- **Un solo entorno.** No hay separación de configuración por
  dev/staging/prod más allá de tener un `.env` distinto; no se pensó
  multi-entorno.
- **Particionamiento de Kafka por defecto.** Los tópicos se auto-crean con
  la configuración por defecto del broker (ver CONTRACT.md) — no se
  dimensionó a propósito una cantidad de particiones pensando en paralelismo
  o volumen esperado. Esto también aplica a los cuatro tópicos `.dlq`.
- **GraphQL sin reglas propias más allá de las que ya tenía REST.** Los
  resolvers reutilizan `validateCreateTransactionInput` tal cual (ver
  DECISIONS.md) — no hay, por ejemplo, validación adicional a nivel de
  schema GraphQL (directivas de formato, límites de longitud) más allá de
  los tipos escalares (`ID`, `Float`, `Int`).
- **`reference-data-service` depende de una única fuente** (BCE). No hay
  una segunda fuente de respaldo si la primera cambia de URL o de dueño; si
  eso pasa, hace falta actualizar `SOURCE_URL` y probablemente el selector
  del scraper a mano.
- **`reference-data-service` con `pg` directo, no Prisma** — ver
  DECISIONS.md. Consecuencia práctica: las migraciones son un único
  `schema.sql` idempotente (`CREATE TABLE IF NOT EXISTS`), no un historial
  de migraciones versionadas como en `transaction-service`.

## Limitaciones de alta concurrencia

- **La prueba de carga incluida (`npm run load-test`, ver
  docs/HIGH_VOLUME.md) es local y reproducible, no un benchmark de
  producción.** Corre contra una sola instancia, en la máquina de quien la
  ejecuta, sin datos de volumen realista en Postgres — sirve para observar
  el comportamiento y comparar antes/después de un cambio, no para sacar una
  cifra de capacidad que valga fuera de esa máquina.
- **Pool de conexiones configurable pero sin un valor "correcto" probado.**
  `DATABASE_POOL_MAX` existe (ver DECISIONS.md) pero su default (10) no
  salió de medir bajo carga real — es un punto de partida razonable, no un
  número validado.
- **Sin circuit breaker.** Si Kafka está *lento* (no caído del todo), el
  relay del outbox puede empezar a acumular filas pendientes más rápido de
  lo que logra publicarlas — hay una métrica para verlo
  (`outbox_pending_events`) pero ningún mecanismo que reaccione solo (por
  ejemplo, pausar temporalmente o alertar).
- **Un solo consumer por servicio.** Tanto el consumer de
  `transaction.fraud-decision` en `transaction-service` como el de
  `transaction.created` en `antifraud-service` corren como una única
  instancia. Escalar horizontalmente (más instancias en el mismo consumer
  group) requeriría además más de una partición por tópico para que
  realmente se reparta el trabajo — no se probó ese escenario.
- **El relay del outbox también es una sola instancia** (ver arriba,
  "Funcionalidades no implementadas") — es, hoy, otro límite de escalado
  horizontal del mismo tipo que el de los consumers.

## Pruebas no realizadas

- **Pruebas de carga a escala de producción** (ver arriba) — sí existe la
  herramienta reproducible (`npm run load-test`), pero no se corrió contra
  infraestructura ni datos representativos de un entorno real.
- **Apagado ordenado: implementado, pero no verificado con una señal real
  en este entorno de desarrollo.** El código (`process.on('SIGTERM'/'SIGINT', ...)`
  en los tres `index.js`) es el patrón estándar de Node.js y funciona bajo
  Docker/Linux (`docker stop` manda `SIGTERM`); sin embargo, se escribió y
  revisó en una máquina Windows, donde `SIGTERM` no es una señal POSIX real
  y no se pudo confirmar el apagado ordenado enviando la señal de verdad a
  un proceso corriendo — solo se verificó por lectura de código. Confirmarlo
  en un entorno Linux/Docker real queda pendiente.
- **Rebalanceo de Kafka**: no se probó qué pasa si una instancia muere a
  mitad de procesar un mensaje y su partición se reasigna — se confía en las
  garantías propias de Kafka (at-least-once) más la idempotencia del
  consumer, pero no hay un test que lo ejercite.
- **Seguridad**: no se corrió ningún fuzzing ni escaneo de dependencias más
  allá de un `npm audit` puntual (que señaló una vulnerabilidad transitiva
  en `deepmerge-ts` vía `@prisma/config`, no resuelta porque implicaría
  bajar de versión Prisma).
- **Múltiples instancias en simultáneo** de un mismo servicio: no probado
  (incluye el relay del outbox — no se probó qué pasa si dos instancias de
  `transaction-service` corren su propio relay contra la misma tabla; en
  principio es seguro porque el `UPDATE ... WHERE published_at IS NULL`
  final es atómico por fila, pero no hay un test que lo confirme bajo
  concurrencia real).
- **`e2e-tests/`** (el flujo completo contra Kafka real, incluida la prueba
  de duplicados y la nueva prueba de DLQ para un `transaction.fraud-decision`
  malformado) están escritos y su lógica de negocio ya está validada por
  separado a nivel de servicio
  ([fraudDecisionIdempotency.test.js](./transaction-service/test/fraudDecisionIdempotency.test.js),
  [outbox.test.js](./transaction-service/test/outbox.test.js)), pero su
  ejecución contra un broker de Kafka real seguía pendiente al momento de
  escribir esta versión del documento — el entorno donde se hizo este
  trabajo no tenía Docker disponible para levantar Kafka. Depende de correr
  `docker compose up -d kafka zookeeper` (ver [README.md](./README.md)).
- **La recolección real de `reference-data-service` contra el sitio del BCE**
  se probó manualmente una vez (funcionó: trajo ~29 monedas, guardó el
  `etag` para la próxima conditional request) pero no es parte de la suite
  automática — los tests automatizados usan fixtures de HTML guardado a
  propósito, para no depender de una fuente externa real ni de la red al
  correr `npm test` (ver docs/WEB_SCRAPING.md).

## Posibles mejoras futuras

En orden aproximado de impacto:

1. **Reprocesamiento automático de la DLQ** — hoy es de solo inspección
   (ver arriba); una herramienta o job que reintente/descarte con una
   política explícita cerraría el ciclo completo de manejo de errores.
2. **Escalar el relay del outbox y los consumers como procesos
   independientes** del servidor HTTP, con más de una instancia y más
   particiones por tópico donde haga falta throughput.
3. **Tracing distribuido real** (OpenTelemetry + un collector) si el número
   de servicios en la cadena creciera lo suficiente como para que la
   correlación por `transactionExternalId` en logs deje de alcanzar.
4. **Autenticación y rate limiting** en los tres servicios HTTP.
5. **Idempotencia en la creación** vía algo como un header
   `Idempotency-Key`, para que un reintento del cliente no duplique la
   transacción (aplica igual a REST y a la mutation de GraphQL).
6. **CI** que corra las cuatro suites de test (y `e2e-tests` contra un
   Kafka real en un runner con Docker) en cada PR.
7. **Pruebas de carga a escala real** para dimensionar el pool de Postgres,
   `OUTBOX_BATCH_SIZE`/`OUTBOX_POLL_INTERVAL_MS`, y la configuración del
   productor/consumer de Kafka con datos reales, en vez de valores por
   defecto razonables pero no medidos.
8. **Una segunda fuente para `reference-data-service`**, con failover
   explícito si la primera deja de responder de forma sostenida.
