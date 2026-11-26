require('dotenv').config({
    path: require('path').join(__dirname, '..', '.env')
});

const { Pool } = require('pg');

let config;

if (process.env.DATABASE_URL) {

    // Облачная PostgreSQL — Neon

    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set('sslmode', 'verify-full');

    config = {
        connectionString: url.toString(),
        enableChannelBinding: true,
        max: 5,
        connectionTimeoutMillis: 15000
    };

    console.log('[DATABASE] Neon PostgreSQL');

} else {

    // Локальная PostgreSQL

    config = {
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME || 'evrika_crm',
        user: process.env.DB_USER || 'evrika_app',
        password: process.env.DB_PASSWORD,
        max: 10
    };

    console.log('[DATABASE] Local PostgreSQL');

}

const pool = new Pool(config);

pool.on('error', error => {
    console.error('[DATABASE]', error.message);
});

async function tx(fn) {

    const c = await pool.connect();

    try {

        await c.query('BEGIN');

        const r = await fn(c);

        await c.query('COMMIT');

        return r;

    } catch (e) {

        await c.query('ROLLBACK');

        throw e;

    } finally {

        c.release();

    }

}

module.exports = { pool, tx };