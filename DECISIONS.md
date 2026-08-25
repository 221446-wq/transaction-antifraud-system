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

Ambos servicios reintentan publicaciones fallidas, pero con estrategias
distintas — no por inconsistencia, sino porque su situación es distinta:

- **`transaction-service`** ya persistió la transacción en Postgres *antes*
  de intentar publicar `transaction.created` (ver la tarea de persistencia
  en README/CONTRACT). Si el publish falla, el dato no se pierde — sigue en
  la base como `pending` — así que el fallo se loguea y la respuesta HTTP
  igual devuelve `201`. Bloquear al cliente esperando reintentos de Kafka no
  aportaría nada, ya que el registro de la transacción está a salvo.
- **`antifraud-service`** no persiste nada (es sin estado, por diseño del
  contrato). Si no logra publicar una decisión, no hay una fila de respaldo
  a la que volver: por eso reintenta con backoff acotado
  ([utils/retry.js](./antifraud-service/src/utils/retry.js)) antes de
  registrar un error definitivo. Agotados los reintentos, se prioriza que el
  consumer siga vivo y procesando los siguientes mensajes por sobre
  garantizar la entrega de esa decisión puntual — la alternativa (dejar que
  Kafka no confirme el offset y reintente indefinidamente) podría trabar el
  procesamiento de mensajes posteriores si el fallo es persistente.
