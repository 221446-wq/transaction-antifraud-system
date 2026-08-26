# Decisiones y asunciones técnicas

Este documento explica el *por qué* detrás de las decisiones técnicas del
proyecto y cómo se interpretaron los puntos que el enunciado dejaba
abiertos. El *qué* (endpoints, esquema, eventos) está en el código y en
[CONTRACT.md](./CONTRACT.md); acá va el razonamiento.

## Framework HTTP: Express

`transaction-service` usa Express 5. La elección no fue muy debatida: el
scaffold inicial del proyecto ya traía `express` como dependencia, y para dos
endpoints REST (`POST /transactions`, `GET /transactions/:externalId`) más un
health check, un framework más grande (Nest, Fastify) habría sido complejidad
sin beneficio real — no hay necesidad de DI, decoradores, ni un ecosistema de
plugins para este alcance. `antifraud-service` directamente no expone HTTP
(ver más abajo), así que no necesitó ningún framework.

## ORM / acceso a base de datos: Prisma + `pg` vía driver adapter

También pre-scaffolded (`@prisma/client`/`prisma` ya estaban en el
`package.json` inicial). Se mantuvo por dar migraciones versionadas,
tipado del cliente, y una forma declarativa de expresar el esquema
(`prisma/schema.prisma`) que sirve como documentación en sí misma.

Dos decisiones no triviales que salieron de usar Prisma 7 (release reciente
al momento de este proyecto), documentadas porque no son obvias si alguien
vuelve a este código después:

- **Generador del cliente**: el generador nuevo por defecto (`prisma-client`)
  solo emite TypeScript fuente, sin JS compilado — inejecutable en un
  proyecto Node plano sin toolchain de TS como este. Se cambió a
  `prisma-client-js` (el generador clásico, CommonJS) en
  [prisma/schema.prisma](./transaction-service/prisma/schema.prisma).
- **Driver adapter obligatorio**: Prisma 7 ya no trae un conector de base de
  datos embebido; hay que pasarle explícitamente un adapter. Se agregó
  `@prisma/adapter-pg` + `pg`, instanciado en
  [src/db/prismaClient.js](./transaction-service/src/db/prismaClient.js).

Decisiones de esquema (ver
[prisma/schema.prisma](./transaction-service/prisma/schema.prisma)):

- `id` interno (serial, autoincrement) separado de `external_id` (UUID,
  único, generado por Prisma al crear) — el interno nunca se expone por la
  API; el externo es el único identificador público, para no filtrar el
  volumen/orden de inserción de la tabla.
- `value` es `Decimal(18,2)`, no `Float` — evita errores de redondeo binario
  en montos de dinero.
- `status` es un **enum nativo de Postgres** (`pending | approved |
  rejected`), no un `VARCHAR` con `CHECK`. Es una garantía más fuerte a nivel
  de base de datos: un valor fuera de esos tres directamente no puede
  insertarse, sin importar qué código lo intente.
- El tipo `transfer` de ejemplo se siembra con un `INSERT` dentro de la
  propia migración SQL (no un script de seed aparte), para que
  `prisma migrate deploy` por sí solo deje la base lista para usar — un solo
  comando, reproducible, sin pasos manuales extra.

## Diseño del contrato de eventos

El contrato completo está en [CONTRACT.md](./CONTRACT.md); acá el
razonamiento de sus decisiones de diseño:

- **Envelope compartido** (`eventId`, `eventType`, `occurredAt`, `data`) para
  los dos eventos, en vez de que cada uno tenga una forma distinta. Da un
  lugar consistente para agregar trazabilidad (`eventId` para
  deduplicar/loguear, `occurredAt` para medir latencia) sin tocar el
  `data` específico de cada evento.
- **Key de Kafka = `transactionExternalId`** en ambos tópicos. Garantiza que
  todos los eventos de una misma transacción caigan en la misma partición y
  se procesen en orden relativo entre sí — importante porque
  `transaction.fraud-decision` solo tiene sentido después de su
  `transaction.created` correspondiente.
- **Auto-creación de tópicos habilitada** (`KAFKA_AUTO_CREATE_TOPICS_ENABLE`
  en `docker-compose.yml`) para simplificar el setup local. Documentado en
  CONTRACT.md como una decisión explícita de desarrollo: en producción se
  crearían de forma declarativa (con la cantidad de particiones y el
  replication factor pensados a propósito), no dependiendo del auto-create.

## Cómo se garantiza la idempotencia

El mecanismo central es un **UPDATE condicional atómico**, no un chequeo
previo ("leer y después decidir"), que sí tendría una carrera:

```sql
UPDATE transactions SET status = $1 WHERE external_id = $2 AND status = 'pending'
```

(`prisma.transaction.updateMany` en
[fraudDecisionService.js](./transaction-service/src/services/fraudDecisionService.js)).
Como la condición `status = 'pending'` viaja *dentro* del mismo `UPDATE`,
Postgres serializa cualquier carrera: si dos decisiones llegan para la misma
transacción (duplicada, reordenada, o incluso dos requests concurrentes),
solo una puede afectar la fila — la que llegue primero al motor de base de
datos. Las demás devuelven `count: 0` y se tratan como no-ops, sin importar
si el duplicado es idéntico o trae un resultado distinto (`approved` después
de que ya se aplicó `rejected`, por ejemplo): nunca se sobrescribe un estado
ya resuelto. Esto está cubierto explícitamente por tests, incluyendo un caso
de dos decisiones disparadas con `Promise.all` sobre la misma fila (ver
[test/fraudDecisionIdempotency.test.js](./transaction-service/test/fraudDecisionIdempotency.test.js)).

La idempotencia de `antifraud-service` es más simple: `evaluateFraudRule` es
una función pura del `value` de la transacción, así que reprocesar el mismo
`transaction.created` (por un reintento, un restart, o una redelivery de
Kafka) siempre produce la misma decisión — no hace falta guardar estado para
evitar recalcularla dos veces distinto.

Esta misma garantía es la que hace seguro el at-least-once del patrón
Outbox (ver abajo): si el relay publica `transaction.created` dos veces
(porque el proceso murió después de un `producer.send()` exitoso pero antes
de marcar la fila como publicada), `antifraud-service` simplemente evalúa la
regla dos veces con el mismo resultado, y el `UPDATE` condicional de arriba
absorbe la decisión duplicada sin corromper nada.

## Patrón Outbox

`POST /transactions` hace dos cosas que tienen que ser atómicas entre sí:
guardar la transacción como `pending`, y dejar constancia de que hay que
publicar `transaction.created`. Antes de este trabajo, eso era un `INSERT`
a Postgres seguido de un `producer.send()` a Kafka — un "dual write"
clásico: si el proceso moría entre el commit y el publish, la transacción
quedaba en `pending` para siempre, sin ningún evento publicado y sin nada
que lo reintentara.

La solución fue mover el `INSERT` en `outbox_events` a la **misma
transacción de Postgres** que el `INSERT` en `transactions`
(`prisma.$transaction` en
[transactionService.js](./transaction-service/src/services/transactionService.js)).
Las dos filas se confirman o fallan juntas: no hay forma de que exista una
sin la otra. Un proceso aparte —el relay,
[outboxRelay.js](./transaction-service/src/outbox/outboxRelay.js), corriendo
en el mismo proceso de Node que el servidor HTTP por simplicidad de
despliegue— sondea la tabla cada `OUTBOX_POLL_INTERVAL_MS` (default 500ms) y
publica lo pendiente.

Consecuencias de este diseño, documentadas a propósito:

- **`POST /transactions` ya no toca Kafka en el camino síncrono.** La
  request solo espera a Postgres. Esto simplificó también el manejo de
  errores: ya no hace falta el `try/catch` alrededor de un publish que
  "no debía romper la respuesta" — ese publish ya no ocurre ahí.
- **Hay una demora entre "guardado" y "publicado"** de hasta un ciclo del
  relay (por defecto, hasta 500ms). Es aceptable porque el flujo entero ya
  es asíncrono por diseño (el enunciado lo dice explícitamente: una
  transacción recién creada puede leerse `pending`).
- **El relay publica en lotes acotados** (`OUTBOX_BATCH_SIZE`, default 20)
  para no intentar drenar miles de filas pendientes en un solo ciclo bajo un
  pico de escrituras — ver docs/HIGH_VOLUME.md.
- **Reintentos con backoff acotado por fila**: si el `producer.send()`
  falla, se incrementa `attempts` y se reintenta en el siguiente ciclo; tras
  `OUTBOX_MAX_ATTEMPTS` (default 10) fallos consecutivos, el evento se
  manda a la DLQ (ver abajo) y se marca `dead_lettered_at` para dejar de
  reintentarlo — un evento con un problema permanente no debe trabar la
  publicación de los que vienen después de él en la tabla.

## Dead-letter queue (DLQ)

Extensión opcional de robustez de entrega de eventos. Cada tópico de
negocio tiene un tópico `.dlq` homónimo — formato completo en CONTRACT.md.
Dos casos concretos escriben ahí, en vez de solo dejar un `console.error`
como antes:

1. Un consumer recibe un mensaje que no cumple el contrato (JSON inválido,
   o le faltan campos) — no tiene sentido reintentar indefinidamente algo
   que nunca va a parsear distinto.
2. Se agotan los reintentos de publicación (el relay del outbox, o
   `antifraud-service` publicando una decisión).

Es deliberadamente un mecanismo de **inspección**, no de reprocesamiento
automático: nada consume esos tópicos ni reintenta republicar en el tópico
original por sí solo. Se documenta como limitación conocida en
LIMITATIONS.md — automatizar esa reinyección es la mejora natural siguiente,
pero requeriría decidir políticas que exceden el alcance de este ejercicio
(¿cuántas veces reintentar desde la DLQ? ¿con qué criterio se descarta
definitivamente un mensaje?).

## Apagado ordenado

Los tres servicios manejan `SIGTERM`/`SIGINT`: dejan de aceptar conexiones
HTTP nuevas (`server.close()`), detienen sus loops de fondo (el relay del
outbox, el scheduler de recolección), desconectan Kafka y Postgres, y recién
ahí salen del proceso — con un timeout de 10s que fuerza la salida si algo
se cuelga, para que un `docker stop` nunca quede esperando indefinidamente.
No había ningún manejo de señales antes; en los tests y pruebas manuales de
este proyecto los procesos se terminaban con `kill`/`Ctrl+C` directos, sin
drenar nada en curso.

## Observabilidad

Tres señales, elegidas por ser las de mayor relación beneficio/costo para
este alcance (el enunciado sugiere "logs estructurados, métricas, tracing,
o health checks" como opciones, no como lista obligatoria completa):

- **Logs estructurados** (`pino`, JSON por línea) reemplazando los
  `console.log`/`console.error` sueltos. Cada log de negocio incluye
  `transactionExternalId`, que funciona como clave de correlación entre los
  logs de `transaction-service` y `antifraud-service` para un mismo flujo
  (`grep` por ese id en los logs de ambos procesos reconstruye la historia
  completa de una transacción). Además, `transaction-service` genera un
  `x-correlation-id` por request HTTP (tomado del header si el cliente lo
  manda) y lo devuelve en la respuesta — útil para atar un log de acceso a
  la petición puntual que lo generó.
- **Métricas Prometheus** (`prom-client`) en `/metrics` de los tres
  servicios: contadores de negocio (transacciones creadas, decisiones
  aplicadas/ignoradas, corridas de recolección) y un gauge del tamaño de la
  cola del outbox — la señal más directa de si el relay está al día o se
  está atrasando.
- **Health checks reales**, separando liveness de readiness:
  `GET /health/live` responde si el proceso está vivo, sin chequear nada
  externo; `GET /health/ready` efectivamente prueba Postgres
  (`SELECT 1`/`SELECT 1` vía el pool) y, en `transaction-service`, si el
  productor de Kafka está conectado — devuelve `503` si alguno falla. Antes
  `/health` respondía `200` sin verificar ninguna dependencia.

**Qué se dejó afuera a propósito: tracing distribuido (OpenTelemetry +
Jaeger/Zipkin).** La correlación por `transactionExternalId` en logs ya
permite reconstruir el flujo completo entre los dos servicios, que es lo
que un trace te daría acá con solo dos "spans" de negocio (crear, decidir).
Agregar el SDK de OpenTelemetry sin un collector real corriendo en
`docker-compose.yml` (no incluido, para no inflar el setup local con un
cuarto contenedor) hubiera sido instrumentación sin ningún lugar donde ver
el resultado — se prefirió no simular una funcionalidad que no se puede
demostrar de verdad. Queda anotado en LIMITATIONS.md como la mejora
siguiente si el proyecto creciera a más de dos servicios en la cadena.

## GraphQL además de REST

Extensión opcional. `transaction-service` expone `POST /graphql`
(`graphql-yoga`) con una `query transaction` y una `mutation
createTransaction`, sin reemplazar la API REST — ambas interfaces conviven.

Decisión central: GraphQL **no reimplementa ninguna regla de negocio**. Los
resolvers llaman exactamente a la misma
[transactionService.js](./transaction-service/src/services/transactionService.js)
y al mismo `validateCreateTransactionInput` que usa el controller REST (ver
[schema.js](./transaction-service/src/graphql/schema.js)). Si mañana cambia
una regla de validación o el manejo del outbox, cambia en un solo lugar y
ambas interfaces lo heredan — la alternativa (una capa de resolvers con su
propia lógica) hubiera sido la clase de duplicación que este proyecto evitó
en todos lados.

Mapeo de errores: en vez de dejar que cualquier excepción se convierta en un
`INTERNAL_SERVER_ERROR` genérico de GraphQL, los errores de dominio
(`ValidationError`, `NotFoundError`) se traducen a `GraphQLError` con
`extensions.code` (`BAD_USER_INPUT`, `NOT_FOUND`) y, para validación,
`extensions.errors` con la misma forma `{ field, message }` que ya devuelve
el REST — así un cliente no tiene que aprender dos formatos de error
distintos según la interfaz que use.

## Alto volumen de lecturas y escrituras simultáneas

Ver [docs/HIGH_VOLUME.md](./docs/HIGH_VOLUME.md) para la nota completa. Acá,
solo las dos decisiones de código que salieron de esa nota: el pool de
Postgres pasó a ser configurable (`DATABASE_POOL_MAX`, antes fijo en el
default de `node-postgres`), y el relay del outbox procesa en lotes
acotados en vez de sin límite — ambos para que un pico de tráfico degrade
la latencia de forma controlada en vez de agotar un recurso compartido de
golpe.

## Extensión de web scraping: `reference-data-service`

Ver [docs/WEB_SCRAPING.md](./docs/WEB_SCRAPING.md) para el diseño completo
(fuente elegida, checkpointing, deduplicación, rate limiting). Acá, por qué
es un servicio aparte y no una tarea dentro de `transaction-service`:

- **Aislamiento de fallos.** Si el HTML de la fuente cambia y el scraper
  empieza a fallar, eso no debe poder afectar la disponibilidad de
  `POST /transactions` ni la evaluación de fraude — son preocupaciones sin
  ninguna relación de negocio entre sí. Un proceso separado hace ese
  aislamiento estructural, no solo una promesa de buenas intenciones en el
  código.
- **Base de datos, no Prisma.** Comparte la misma instancia de Postgres que
  `transaction-service` (dos tablas propias, sin relación con
  `transactions`/`outbox_events`) pero accede con `pg` directo. Para dos
  tablas y consultas simples, el setup de Prisma (schema, generador,
  adapter) hubiera sido overhead sin beneficio — el mismo criterio que ya
  se aplicó al elegir Express liviano en vez de un framework grande (ver
  arriba).

## Requisitos ambiguos y las decisiones tomadas

### `transferTypeId` que no existe

El enunciado no especifica qué hacer si el `transferTypeId` recibido no
corresponde a ningún tipo sembrado. Se decidió validarlo en la capa de API
(no dejar que reviente como un error de foreign key en la base): si no
existe, `POST /transactions` responde `400` con
`{ field: "transferTypeId", message: "No existe un tipo de transacción con
id <id>." }` y **no se crea ninguna fila** — ver
[transactionValidator.js](./transaction-service/src/validators/transactionValidator.js).
La razón: un error de validación (dato de entrada incorrecto) es
responsabilidad del cliente y debe ser un `4xx` claro, no un `500` genérico
que además expondría detalles de la base de datos.

### `value`: cero y negativos

El enunciado no dice explícitamente que `value` deba ser positivo, pero un
monto de transacción de `0` o negativo no tiene sentido de negocio. Se
decidió rechazar ambos con `400` (`"Debe ser mayor a 0."`), tratándolos como
error de validación en vez de dejarlos pasar y que la regla antifraude los
apruebe trivialmente (`0 ≤ 1000`).

### `external_id` con formato inválido en `GET /transactions/:externalId`

La columna es `UUID` en Postgres; pasarle un string que no es UUID haría que
la consulta fallara con un error de sintaxis de la base (`500`). Se decidió
tratar un `externalId` mal formado igual que uno bien formado pero
inexistente: `404`, porque desde la perspectiva del cliente ambos casos son
"no hay ninguna transacción con ese id" — y evita filtrar un detalle de
implementación (el tipo de columna) en un error 500.

### Formato uniforme de errores

El enunciado no define un formato de error. Se estandarizó
`{ errors: [{ field, message }] }` para *todas* las respuestas de error de
`transaction-service` (400, 404 y 500 — incluidas rutas no encontradas y
body JSON malformado), centralizado en un único middleware
([errorHandler.js](./transaction-service/src/middlewares/errorHandler.js))
para que ningún endpoint tenga que construir su propia forma de error.

### Fallos de Kafka: comportamiento distinto a propósito entre los dos servicios

`transaction-service` y `antifraud-service` manejan un publish fallido de
forma distinta — no por inconsistencia, sino porque su situación es
distinta:

- **`transaction-service` ya no publica de forma síncrona en absoluto**
  (ver "Patrón Outbox" más arriba): `POST /transactions` solo escribe en
  Postgres, dentro de una transacción que incluye la fila del outbox. El
  publish real a Kafka lo hace el relay del outbox, de forma completamente
  desacoplada de cualquier request HTTP — así que "Kafka está caído cuando
  llega un `POST /transactions`" ya ni siquiera es un caso a manejar en ese
  camino: la transacción se guarda igual, y el relay reintenta publicar su
  evento en cuanto Kafka vuelva.
- **`antifraud-service` no persiste nada** (es sin estado, por diseño del
  contrato). Si no logra publicar una decisión, no hay una fila de respaldo
  a la que volver: por eso reintenta con backoff acotado
  ([utils/retry.js](./antifraud-service/src/utils/retry.js)) antes de
  mandar el mensaje a la DLQ (ver arriba). Agotados los reintentos, se
  prioriza que el consumer siga vivo y procesando los siguientes mensajes
  por sobre garantizar la entrega de esa decisión puntual — la alternativa
  (dejar que Kafka no confirme el offset y reintente indefinidamente) podría
  trabar el procesamiento de mensajes posteriores si el fallo es
  persistente.
