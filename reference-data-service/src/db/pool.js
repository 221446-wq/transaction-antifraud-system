const { Pool } = require('pg');
const env = require('../config/env');

/**
 * `pg` directo, sin ORM: este servicio es chico (dos tablas, consultas
 * simples) y ya corre en un ecosistema con Prisma en otro servicio — no
 * vale la pena repetir el setup de Prisma (schema, generador, adapter) para
 * esto. Ver docs/WEB_SCRAPING.md.
 */
const pool = new Pool({ connectionString: env.databaseUrl });

module.exports = pool;
