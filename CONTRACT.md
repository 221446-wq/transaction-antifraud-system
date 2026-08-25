# Contrato de eventos — Transaction Service ↔ Antifraud Service

Este documento es la fuente única de verdad sobre cómo se comunican ambos
servicios a través de Kafka. Cualquier cambio a esta estructura debe
reflejarse en ambos servicios al mismo tiempo.

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
