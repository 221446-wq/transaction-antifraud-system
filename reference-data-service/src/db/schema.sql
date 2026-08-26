-- reference-data-service: tablas propias en la misma base de Postgres que
-- transaction-service (transactions_db), sin relación alguna con las tablas
-- de negocio (transactions, outbox_events) — ver docs/WEB_SCRAPING.md.
--
-- `reference_rate_sources` cumple dos roles a la vez:
--   1) caché de validador HTTP (etag/last_modified) para hacer conditional
--      requests y no re-descargar la página si no cambió.
--   2) checkpoint de progreso: como el estado vive en la base y no en
--      memoria, un restart del proceso retoma exactamente donde se había
--      quedado (mismo etag, mismo fingerprint) en vez de perder el avance.
CREATE TABLE IF NOT EXISTS reference_rate_sources (
    id                    SERIAL PRIMARY KEY,
    name                  TEXT NOT NULL UNIQUE,
    url                   TEXT NOT NULL,
    etag                  TEXT,
    last_modified         TEXT,
    last_fingerprint      TEXT,
    last_checked_at       TIMESTAMPTZ,
    last_success_at       TIMESTAMPTZ,
    consecutive_failures  INTEGER NOT NULL DEFAULT 0
);

-- Una fila por (fuente, moneda, fecha de referencia publicada). El UNIQUE
-- hace que reprocesar la misma corrida (mismo día) sea un upsert idempotente
-- en vez de duplicar filas.
CREATE TABLE IF NOT EXISTS reference_rates (
    id               SERIAL PRIMARY KEY,
    source_id        INTEGER NOT NULL REFERENCES reference_rate_sources(id),
    base_currency    TEXT NOT NULL,
    quote_currency   TEXT NOT NULL,
    rate             NUMERIC(18, 6) NOT NULL,
    rate_date        DATE NOT NULL,
    source_url       TEXT NOT NULL,
    fingerprint      TEXT NOT NULL,
    retrieved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_id, quote_currency, rate_date)
);

CREATE INDEX IF NOT EXISTS reference_rates_quote_currency_idx
    ON reference_rates (quote_currency, rate_date DESC);
