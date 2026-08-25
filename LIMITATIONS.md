# Limitaciones conocidas

Este documento es un inventario honesto de lo que **no** está hecho, lo que
se simplificó a propósito, y lo que se sabe que falta probar — para que
nadie lo descubra por sorpresa. Las decisiones de diseño de lo que sí se
implementó están en [DECISIONS.md](./DECISIONS.md).

## Funcionalidades no implementadas

- **Patrón Outbox: no implementado.** Ver sección dedicada más abajo — es la
  limitación más importante del proyecto.
- **Dead-letter queue / tópico de reintentos agotados.** Cuando
  `antifraud-service` agota los reintentos de publicar una decisión (ver
  [retry.js](./antifraud-service/src/utils/retry.js)), o cuando cualquiera de
  los dos consumers descarta un mensaje malformado, el único rastro que
  queda es un `console.error`. No hay un tópico ni una tabla de
  "mensajes fallidos" para inspeccionar o reprocesar esos casos después.
- **Autenticación/autorización.** `POST /transactions` y
  `GET /transactions/:externalId` son públicos — cualquiera que le pegue al
  puerto puede crear o consultar transacciones. No hay API keys, JWT, ni
  ningún control de acceso.
- **Rate limiting.** Ningún endpoint tiene límite de tasa.
- **Listado/paginación de transacciones.** Solo existe consulta por
  `external_id` individual; no hay un `GET /transactions` con filtros o
  paginación.
- **Idempotencia en la *creación*.** La idempotencia que sí está garantizada
  (ver DECISIONS.md) es la del *consumo* de `transaction.fraud-decision`.
  `POST /transactions` no tiene protección contra duplicados del lado del
  cliente: si un cliente reintenta una creación (por un timeout, por
  ejemplo) sin mandar ningún identificador de idempotencia, el resultado son
  dos transacciones distintas, cada una con su propio `external_id`.
- **Apagado ordenado (graceful shutdown).** Ningún proceso maneja
  `SIGTERM`/`SIGINT` para desconectar el productor/consumer de Kafka o
  Prisma antes de salir. En los tests y en las pruebas manuales de este
  proyecto los procesos se terminaron con `kill`/`Ctrl+C` directos.
- **Health check real.** `GET /health` en `transaction-service` responde
  `200` sin verificar que Postgres o Kafka estén realmente accesibles — es
  un check de "el proceso está vivo", no de "el proceso está listo".
  `antifraud-service` no expone ningún endpoint HTTP, ni siquiera ese.
- **Observabilidad.** Solo hay `console.log`/`console.error` (ver ticket de
  trazabilidad). No hay métricas (Prometheus), tracing distribuido, ni logs
  estructurados en JSON con un logger real.
- **Extensiones opcionales del enunciado no abordadas**: GraphQL, y las dos
  extensiones de web-scraping (recolección de tipo de cambio). Se priorizó
  el flujo principal y su robustez por sobre estas extensiones.
- **CI/CD.** No hay ningún pipeline (GitHub Actions o similar) que corra las
  tres suites de test automáticamente en cada cambio.

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
  o volumen esperado.

## Patrón Outbox: no implementado

`transaction-service` hace, en `POST /transactions`, dos operaciones
separadas y **no atómicas entre sí**: primero un `INSERT` en Postgres
(commiteado), después un `producer.send()` a Kafka
(ver [transactionController.js](./transaction-service/src/controllers/transactionController.js)).

Esto es el problema clásico de "dual write". Ya está cubierto el caso en que
el publish *falla de forma visible* (Kafka no responde, se loguea el error y
la transacción queda `pending` de forma segura — ver DECISIONS.md). Lo que
**no** está cubierto es el caso en que el proceso muere *entre* el commit a
Postgres y el publish a Kafka (un crash, un `OOM kill`, un deploy en mal
momento): la transacción queda guardada como `pending` en la base, pero el
evento `transaction.created` nunca se publicó y nunca se va a reintentar —
nadie vuelve a leer esa fila para reintentar publicarla. El resultado es una
transacción que se queda en `pending` para siempre, silenciosamente, sin
ningún error visible.

El patrón Outbox (escribir el evento a publicar en una tabla `outbox` dentro
de la *misma* transacción de base de datos que el `INSERT` del negocio, y
tener un proceso aparte que lee esa tabla y publica con reintentos hasta
confirmar) es la forma estándar de cerrar este gap, y es justamente una de
las extensiones opcionales que sugiere el enunciado. No se implementó por
alcance/tiempo — queda como la mejora de mayor impacto pendiente.

## Limitaciones de alta concurrencia

- **No se hizo ninguna prueba de carga.** No hay benchmark con k6,
  autocannon, ni artillery — el comportamiento bajo volumen alto es
  observación empírica, no medición.
- **Pool de conexiones sin ajustar.** `@prisma/adapter-pg` usa un `pg.Pool`
  con los valores por defecto de `node-postgres`; no se dimensionó el
  tamaño del pool pensando en concurrencia esperada, así que bajo carga alta
  las requests podrían empezar a esperar una conexión libre sin que eso sea
  visible como error.
- **Sin circuit breaker.** Si Kafka está *lento* (no caído del todo), el
  `await` al productor dentro de `POST /transactions` puede degradar la
  latencia p99 del endpoint — el manejo actual solo distingue "funciona" vs
  "falla tras agotar reintentos", no un estado intermedio de degradación.
- **Un solo consumer por servicio.** Tanto el consumer de
  `transaction.fraud-decision` en `transaction-service` como el de
  `transaction.created` en `antifraud-service` corren como una única
  instancia. Escalar horizontalmente (más instancias en el mismo consumer
  group) requeriría además más de una partición por tópico para que
  realmente se reparta el trabajo — no se probó ese escenario.
- La extensión opcional del enunciado *"mostrar cómo el sistema manejaría un
  volumen alto de lecturas y escrituras simultáneas"* no se abordó ni con
  código, tests, ni una nota de diseño dedicada.

## Pruebas no realizadas

- **Pruebas de carga/rendimiento** (ver arriba).
- **El caso que el Outbox resolvería** no tiene test — no se puede probar
  automáticamente un comportamiento que no existe (matar el proceso justo
  entre el `INSERT` y el `send`).
- **Apagado ordenado**: no hay test porque no está implementado.
- **Rebalanceo de Kafka**: no se probó qué pasa si una instancia muere a
  mitad de procesar un mensaje y su partición se reasigna — se confía en las
  garantías propias de Kafka (at-least-once) más la idempotencia del
  consumer, pero no hay un test que lo ejercite.
- **Seguridad**: no se corrió ningún fuzzing ni escaneo de dependencias más
  allá de un `npm audit` puntual (que señaló una vulnerabilidad transitiva
  en `deepmerge-ts` vía `@prisma/config`, no resuelta porque implicaría
  bajar de versión Prisma).
- **Múltiples instancias en simultáneo** de un mismo servicio: no probado.
- **`e2e-tests/`** (el flujo completo contra Kafka real, incluida la prueba
  de duplicados) están escritos y su lógica de negocio ya está validada por
  separado a nivel de servicio
  ([fraudDecisionIdempotency.test.js](./transaction-service/test/fraudDecisionIdempotency.test.js)),
  pero su ejecución contra un broker de Kafka real todavía estaba pendiente
  al momento de escribir este documento — depende de tener
  `docker compose up -d kafka zookeeper` corriendo (ver
  [README.md](./README.md)).

## Posibles mejoras futuras

En orden aproximado de impacto:

1. **Outbox pattern** (o Change Data Capture con algo como Debezium) para
   cerrar el gap de dual-write descrito arriba — es lo primero que
   resolvería antes de llevar esto a producción de verdad.
2. **Dead-letter topic/tabla** para mensajes que agotan reintentos o fallan
   el parseo, con una forma de inspeccionarlos y reprocesarlos.
3. **Apagado ordenado** (`SIGTERM`) en ambos servicios: dejar de aceptar
   requests nuevas, drenar las Kafka en vuelo, desconectar Prisma y los
   clientes de Kafka antes de salir.
4. **Health checks reales** (`/health/ready` que efectivamente chequee
   Postgres y Kafka, no solo "el proceso responde").
5. **Autenticación y rate limiting** en la API REST.
6. **Logging estructurado** (JSON, con un logger tipo pino/winston) y
   propagar `eventId` como id de correlación entre servicios y entre logs.
7. **Métricas** (Prometheus) — throughput de creación, latencia de
   decisión antifraude end-to-end, tasa de reintentos/errores definitivos.
8. **Idempotencia en la creación** vía algo como un header
   `Idempotency-Key`, para que un reintento del cliente no duplique la
   transacción.
9. **CI** que corra las tres suites de test en cada PR.
10. **Pruebas de carga** para dimensionar el pool de Postgres y la
    configuración del productor/consumer de Kafka con datos reales, en vez
    de valores por defecto.
