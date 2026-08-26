# Contrato de eventos — Transaction Service ↔ Antifraud Service

Este documento es la fuente única de verdad sobre cómo se comunican ambos
servicios a través de Kafka. Cualquier cambio a esta estructura debe
reflejarse en ambos servicios al mismo tiempo.

`reference-data-service` (extensión opcional, ver docs/WEB_SCRAPING.md) está
fuera del alcance de este documento a propósito: no publica ni consume
ningún tópico de Kafka, y no comparte base de datos de negocio con estos dos
servicios — es un worker independiente sin ningún acoplamiento con el
contrato de abajo.

## Tópicos

| Tópico                        | Productor            | Consumidor           |
|--------------------------------|-----------------------|-----------------------|
| `transaction.created`          | transaction-service   | antifraud-service     |
| `transaction.fraud-decision`   | antifraud-service     | transaction-service   |

- Los tópicos se crean automáticamente al publicar/consumir por primera vez
  (`KAFKA_AUTO_CREATE_TOPICS_ENABLE=true` en `docker-compose.yml`). Se documenta
  aquí como decisión explícita: en un entorno productivo se crearían de forma
  manual/declarativa en vez de depender del auto-create.
- **Key del mensaje:** en ambos tópicos, la key de Kafka es el
  `transactionExternalId` (como string). Esto garantiza que todos los eventos
  de una misma transacción caigan en la misma partición y se procesen en
  orden.

## Formato general del envelope

Todos los eventos comparten esta envoltura, y el contenido específico va en
`data`:

```json
{
  "eventId": "c3a2f9de-3b7a-4b7a-9b8e-2a2a1f9b0e11",
  "eventType": "transaction.created",
  "occurredAt": "2026-01-15T13:45:30.000Z",
  "data": { }
}
```

| Campo        | Tipo   | Descripción                                              |
|--------------|--------|-----------------------------------------------------------|
| `eventId`    | UUID   | Identificador único del evento (no de la transacción).   |
| `eventType`  | string | Debe coincidir exactamente con el nombre del tópico.      |
| `occurredAt` | string | Fecha/hora ISO 8601 en UTC de cuándo ocurrió el evento.   |
| `data`       | object | Payload específico de cada evento (ver abajo).             |

## Evento: `transaction.created`

Publicado por **transaction-service** inmediatamente después de guardar la
transacción como `pending`.

```json
{
  "eventId": "c3a2f9de-3b7a-4b7a-9b8e-2a2a1f9b0e11",
  "eventType": "transaction.created",
  "occurredAt": "2026-01-15T13:45:30.000Z",
  "data": {
    "transactionExternalId": "d6674f5f-c4bc-4e74-9236-66370946c625",
    "value": 120
  }
}
```

| Campo (`data`)             | Tipo   | Obligatorio | Descripción                                  |
|-----------------------------|--------|-------------|-----------------------------------------------|
| `transactionExternalId`     | UUID   | Sí          | Identificador externo de la transacción.      |
| `value`                     | number | Sí          | Monto de la transacción, usado por la regla.  |

## Evento: `transaction.fraud-decision`

Publicado por **antifraud-service** después de evaluar la regla de negocio.

```json
{
  "eventId": "9b1e2f3a-1234-4d5e-8a6b-7c8d9e0f1a2b",
  "eventType": "transaction.fraud-decision",
  "occurredAt": "2026-01-15T13:45:31.500Z",
  "data": {
    "transactionExternalId": "d6674f5f-c4bc-4e74-9236-66370946c625",
    "status": "approved"
  }
}
```

| Campo (`data`)             | Tipo   | Obligatorio | Descripción                                              |
|-----------------------------|--------|-------------|------------------------------------------------------------|
| `transactionExternalId`     | UUID   | Sí          | Debe coincidir con el de `transaction.created`.            |
| `status`                    | string | Sí          | Únicamente `"approved"` o `"rejected"`. Nunca `"pending"`. |

## Tópicos dead-letter (DLQ)

Extensión opcional de "entrega de eventos más robusta" (ver README.md). Cada
tópico de negocio tiene un tópico dead-letter homónimo con el sufijo `.dlq`:

| Tópico de negocio             | Tópico DLQ                          |
|--------------------------------|--------------------------------------|
| `transaction.created`          | `transaction.created.dlq`           |
| `transaction.fraud-decision`   | `transaction.fraud-decision.dlq`    |

Un mensaje termina en la DLQ correspondiente en dos casos:

1. **Parseo inválido**: el consumer no pudo extraer los campos esperados del
   mensaje (JSON inválido, o le faltan campos requeridos por el contrato).
2. **Reintentos de publicación agotados**: quien iba a publicar el evento
   (el relay del outbox para `transaction.created`, o `antifraud-service`
   para `transaction.fraud-decision`) no pudo hacerlo tras varios intentos
   con backoff.

Formato del mensaje en la DLQ (mismo envelope, con su propio `data`):

```json
{
  "eventId": "b1c2d3e4-...",
  "eventType": "transaction.fraud-decision.dlq",
  "occurredAt": "2026-01-15T13:45:32.000Z",
  "data": {
    "originalTopic": "transaction.fraud-decision",
    "reason": "invalid_event",
    "error": "El evento no trae un data.transactionExternalId válido.",
    "event": { "...": "el evento original ya parseado, si se llegó a construir" },
    "rawValue": "el string crudo del mensaje, si el parseo fue lo que falló"
  }
}
```

| Campo (`data`)  | Descripción                                                          |
|------------------|-----------------------------------------------------------------------|
| `originalTopic`  | Tópico de negocio del que vino el mensaje.                            |
| `reason`         | `invalid_event` \| `outbox_max_attempts_exceeded` \| `publish_retries_exhausted`. |
| `error`          | Mensaje del último error.                                             |
| `event`          | El evento ya parseado/decidido, cuando existe (p.ej. la decisión que no se pudo publicar). `null` si no aplica. |
| `rawValue`       | Los bytes crudos del mensaje original, cuando el fallo fue de parseo. `null` si no aplica. |

La DLQ es **solo de inspección** en este proyecto: nada la consume ni
reprocesa automáticamente (ver LIMITATIONS.md). Reprocesar un mensaje hoy es
un paso manual: leerlo de la DLQ y republicarlo a mano en el tópico
original.

## Reglas que ambos servicios deben respetar

1. **Nunca renombrar campos** sin actualizar este documento y ambos
   servicios en el mismo cambio.
2. **`antifraud-service` es sin estado**: no persiste nada, solo transforma
   `transaction.created` en `transaction.fraud-decision`.
3. **`transaction-service` es responsable de la idempotencia**: al consumir
   `transaction.fraud-decision`, debe actualizar el estado solo si la
   transacción sigue en `pending` (ver tarea de consumer de decisiones).
4. **`status` en `transaction.fraud-decision` es un resultado cerrado**: solo
   dos valores posibles, sin estados intermedios.
