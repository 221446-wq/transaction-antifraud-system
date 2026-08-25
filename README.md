# Reto backend — Transacciones + Antifraude

Sistema de dos servicios independientes (`transaction-service` y
`antifraud-service`) que se comunican de forma asíncrona por Kafka. El
contrato de eventos entre ambos está documentado en [CONTRACT.md](./CONTRACT.md),
y el razonamiento detrás de las decisiones técnicas y las asunciones sobre
requisitos no especificados está en [DECISIONS.md](./DECISIONS.md).

Esta guía asume que **no tenés nada instalado todavía** más que Node.js y
Docker, y te lleva paso a paso hasta tener el sistema completo corriendo en tu
máquina.

## Requisitos previos

- [Node.js](https://nodejs.org/) 22 o superior (`node -v` para verificar).
- [Docker](https://www.docker.com/) y Docker Compose (`docker compose version`
  para verificar).
- Un cliente de línea de comandos (en Windows, PowerShell o Git Bash — los
  comandos de este documento funcionan en ambos salvo donde se indique).

## 1. Levantar la infraestructura (PostgreSQL + Kafka)

Desde la raíz del repositorio:

```bash
docker compose up -d
```

Esto levanta tres contenedores:

| Servicio    | Puerto en tu máquina | Para qué                                 |
|-------------|-----------------------|-------------------------------------------|
| `postgres`  | `5432`                 | Base de datos de `transaction-service`.   |
| `zookeeper` | (interno)              | Requisito de Kafka.                       |
| `kafka`     | `9092`                 | Comunicación entre ambos servicios.       |

Verificá que los tres estén arriba:

```bash
docker compose ps
```

Los tres deberían figurar como `running`/`healthy`. Si el puerto `5432` o
`9092` ya está ocupado por otra cosa en tu máquina, `docker compose` va a
fallar al levantar ese contenedor puntual — liberá el puerto o cambiá el
mapeo en [docker-compose.yml](./docker-compose.yml) antes de seguir.

## 2. Configurar las variables de entorno

Cada servicio tiene su propio `.env.example` con los valores que ya coinciden
con el `docker-compose.yml` de arriba. Copiálo a `.env` en cada uno:

```bash
# Bash / Git Bash
cp transaction-service/.env.example transaction-service/.env
cp antifraud-service/.env.example antifraud-service/.env
```

```powershell
# PowerShell
Copy-Item transaction-service\.env.example transaction-service\.env
Copy-Item antifraud-service\.env.example antifraud-service\.env
```

No hace falta editar nada para correr todo localmente con el
`docker-compose.yml` incluido — los valores por defecto ya apuntan a
`localhost:5432` y `localhost:9092`.

| Variable                  | Servicio            | Qué es |
|----------------------------|---------------------|--------|
| `PORT`                     | transaction-service | Puerto HTTP del servicio (default `3000`). |
| `DATABASE_URL`             | transaction-service | Cadena de conexión a PostgreSQL. |
| `KAFKA_BROKERS`            | ambos                | Broker(s) de Kafka, separados por coma. |
| `KAFKA_CLIENT_ID`          | ambos                | Identificador del servicio ante Kafka (solo informativo/logs). |
| `KAFKA_CONSUMER_GROUP_ID`  | antifraud-service    | Consumer group del consumer de `transaction.created`. |

## 3. Instalar dependencias — `transaction-service`

```bash
cd transaction-service
npm install
```

## 4. Aplicar las migraciones de la base de datos

Con Postgres arriba (paso 1) y las dependencias instaladas (paso 3), seguís
parado en `transaction-service/`:

```bash
npx prisma migrate deploy
npx prisma generate
```

- `migrate deploy` crea las tablas (`transactions`, `transaction_types`) y
  siembra el tipo `transfer` de ejemplo — ver
  [prisma/migrations](./transaction-service/prisma/migrations).
- `generate` genera el cliente de Prisma en `src/generated/prisma` (no se
  versiona en git, hace falta correrlo después de cada `npm install` en un
  checkout nuevo).

## 5. Instalar dependencias — `antifraud-service`

Desde la raíz del repositorio:

```bash
cd antifraud-service
npm install
```

Este servicio no usa base de datos (es sin estado, ver
[CONTRACT.md](./CONTRACT.md)), así que no tiene un paso de migraciones.

## 6. Iniciar ambos servicios

Cada servicio corre en su propio proceso — necesitás **dos terminales**
abiertas, una por servicio.

**Terminal 1 — transaction-service:**

```bash
cd transaction-service
npm start
```

Deberías ver `transaction-service escuchando en el puerto 3000`. Probalo con:

```bash
curl http://localhost:3000/health
```

**Terminal 2 — antifraud-service:**

```bash
cd antifraud-service
npm start
```

Deberías ver `antifraud-service inicializado (...)`. Este servicio no expone
HTTP: solo vas a ver actividad en sus logs cuando procese eventos.

> Para desarrollo, `npm run dev` en cualquiera de los dos usa `nodemon` y
> reinicia solo ante cambios de código.

### Probar el flujo manualmente

Con ambos servicios corriendo, creá una transacción:

```bash
curl -X POST http://localhost:3000/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "accountExternalIdDebit": "2b894fb0-09f1-4d46-a610-0c92a5c4e113",
    "accountExternalIdCredit": "045d5400-e3cf-4e57-9fe4-a9815eeec2c4",
    "transferTypeId": 1,
    "value": 120
  }'
```

La respuesta trae un `transactionExternalId` con estado `pending`. Consultala
de nuevo un segundo después (ya debería estar resuelta por `antifraud-service`):

```bash
curl http://localhost:3000/transactions/<transactionExternalId>
```

Con `value: 120` (≤ 1000) el estado final debería ser `approved`; con un
`value` mayor a `1000`, `rejected`.

## 7. Ejecutar los tests

Hay tres suites independientes:

**`transaction-service`** (necesita Postgres arriba; Kafka es opcional — si
no está disponible, los tests igual pasan porque el servicio está diseñado
para degradarse sin perder datos):

```bash
cd transaction-service
npm test
```

**`antifraud-service`** (no necesita nada levantado — son pruebas puras de
la regla de negocio y del helper de reintentos):

```bash
cd antifraud-service
npm test
```

**`e2e-tests`** (prueba el flujo asíncrono completo con los dos servicios
reales hablando por Kafka real — necesita Postgres **y** Kafka arriba, ver
paso 1). Esta suite levanta sus propias instancias de ambos servicios como
procesos hijos: **cerrá primero las terminales del paso 6** (`Ctrl+C`) antes
de correrla, para que no compitan por el puerto `3000`.

```bash
cd e2e-tests
npm install
npm test
```

## Solución de problemas comunes

- **`Error: Falta la variable de entorno obligatoria: DATABASE_URL`** — no
  copiaste el `.env.example` a `.env` (paso 2), o lo estás corriendo desde el
  directorio equivocado.
- **Un contenedor de `docker compose up` no arranca** — probablemente el
  puerto `5432` o `9092` ya está ocupado por otro proceso en tu máquina;
  liberalo o cambiá el mapeo de puertos en `docker-compose.yml`.
- **`EADDRINUSE` al correr `e2e-tests`** — ya tenés `transaction-service`
  corriendo manualmente (paso 6) en el puerto `3000`; cerralo antes de correr
  la suite end-to-end.
- **Una transacción se queda en `pending` para siempre** — confirmá que
  `antifraud-service` esté efectivamente corriendo y que ambos servicios
  tengan `KAFKA_BROKERS=localhost:9092` en su `.env`.

## Estructura del repositorio

```
.
├── CONTRACT.md            # Contrato de eventos entre ambos servicios
├── docker-compose.yml      # PostgreSQL + Kafka + Zookeeper para desarrollo local
├── transaction-service/    # API REST + persistencia + productor/consumer de Kafka
├── antifraud-service/      # Consumer de transaction.created + regla de fraude + productor de la decisión
└── e2e-tests/               # Pruebas end-to-end de todo el flujo, contra Kafka real
```
