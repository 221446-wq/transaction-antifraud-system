# Alto volumen de lecturas y escrituras simultáneas

Extensión opcional del enunciado ("mostrar cómo el sistema manejaría un
volumen alto de lecturas y escrituras simultáneas"). No es una prueba de
carga real contra infraestructura de producción — es una nota de diseño más
una herramienta reproducible ([scripts/loadTest.js](../transaction-service/scripts/loadTest.js))
para observar el comportamiento actual y razonar sobre los próximos cuellos
de botella.

## Qué hace escalable a la arquitectura actual, sin cambios

- **`transaction-service` es sin estado.** No guarda nada en memoria entre
  requests (ni sesiones, ni caches locales); toda la data vive en Postgres.
  Eso significa que agregar más instancias detrás de un load balancer es un
  cambio de infraestructura, no de código.
- **Kafka desacopla los dos servicios.** `antifraud-service` puede procesar
  a su propio ritmo sin frenar la respuesta HTTP de `POST /transactions`
  (que ya no toca Kafka de forma síncrona — ver el patrón Outbox en
  DECISIONS.md). Un pico de tráfico se absorbe como una cola más larga, no
  como un 5xx.
- **El outbox además desacopla la escritura del publish.** `POST
  /transactions` en el camino feliz hace un solo round-trip a Postgres
  (un `INSERT` + un `INSERT` en la misma transacción); nunca espera a
  Kafka. Eso limita la latencia p99 de escritura a "qué tan rápido responde
  Postgres", no a "qué tan rápido responde Kafka".
- **La lectura por `external_id` ya usa un índice único** (`@unique` en el
  schema de Prisma → `UNIQUE INDEX` en Postgres), así que `GET
  /transactions/:externalId` es una búsqueda O(log n), no un table scan.

## Qué se ajustó puntualmente en este trabajo

- **Pool de conexiones a Postgres dimensionable**: `DATABASE_POOL_MAX` (ver
  `.env.example`), en vez del default fijo de `node-postgres`. El valor
  correcto depende de `max_connections` de Postgres y de cuántas instancias
  de `transaction-service` corran en paralelo — no hay un número universal,
  por eso es una variable de entorno y no una constante.
- **El relay del outbox procesa en batches** (`OUTBOX_BATCH_SIZE`,
  `OUTBOX_POLL_INTERVAL_MS`), no fila por fila sin límite: bajo un pico de
  escrituras, el relay no intenta publicar miles de eventos en un solo
  ciclo y saturar al productor de Kafka.

## Próximos cuellos de botella, en el orden en que probablemente aparecerían

1. **El pool de Postgres.** Es el primer límite duro: con `max=10` (default),
   la request número 11 concurrente espera una conexión libre. Subir el pool
   ayuda hasta el límite de `max_connections` del servidor; más allá de eso
   hace falta un pooler externo (PgBouncer) o lecturas en una réplica.
2. **Un único consumer por tópico.** Tanto `antifraud-service` como el
   consumer de `transaction.fraud-decision` en `transaction-service` corren
   como una sola instancia (ver LIMITATIONS.md). Escalar el procesamiento
   requiere más particiones en el tópico y más instancias en el mismo
   consumer group — Kafka reparte las particiones entre ellas
   automáticamente, sin cambiar código.
3. **El relay del outbox es una sola instancia dentro de
   `transaction-service`.** Si el volumen de escrituras supera lo que un
   relay puede publicar, la tabla `outbox_events` crece pero el impacto
   queda contenido al lag de publicación (la respuesta HTTP y la
   consistencia de datos no se ven afectadas) — es una desventaja aceptable
   del diseño actual, documentada en vez de resuelta.
4. **Lecturas repetidas del mismo `external_id`.** Hoy cada `GET` pega
   directo a Postgres. Si un mismo id se consulta con mucha frecuencia (polling
   del cliente esperando que salga de `pending`), un cache de corta duración
   (Redis, o incluso in-memory con TTL de 1-2s) delante de la lectura
   evitaría carga repetida sin arriesgar servir un estado muy desactualizado.

## Cómo correr la prueba de carga incluida

```bash
cd transaction-service
npm install
npm start            # en otra terminal, con Postgres arriba
npm run load-test    # en una tercera terminal
```

Corre tres fases (escritura, lectura, mixta) usando `autocannon` y sondea el
servicio local. Parámetros configurables por variable de entorno:
`LOAD_TEST_URL`, `LOAD_TEST_CONNECTIONS`, `LOAD_TEST_DURATION`.

No necesita Kafka arriba: mide el camino síncrono (HTTP + Postgres), que es
lo único que el cliente espera. Los resultados dependen totalmente del
hardware donde se corra — no se documentan cifras absolutas acá a propósito,
para no dar una falsa sensación de benchmark comparable entre máquinas.

## Qué haría falta para una prueba de carga real (no incluido)

- Un entorno con recursos fijos y conocidos (no una laptop de desarrollo).
- Datos de Postgres con volumen realista (no una tabla vacía: los índices se
  comportan distinto con millones de filas que con cientos).
- Kafka con las particiones/réplicas pensadas para el throughput esperado,
  no la configuración por defecto de `docker-compose.yml` (ver CONTRACT.md).
- Métricas durante la corrida (ver `/metrics` en ambos servicios) para
  correlacionar la degradación con una causa concreta (pool agotado, CPU,
  lag de consumer) en vez de solo ver la latencia subir.
