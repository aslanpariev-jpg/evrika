'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const { createService } = require('../server/monitor/service');
const { migrate, stats, listListings } = require('../server/monitor/store');

const databaseUrl = process.env.MONITOR_TEST_DATABASE_URL;
const fixture = join(__dirname, 'fixtures', 'monitor', 'text.eml');

async function waitFor(check) {
    for (let i = 0; i < 180; i += 1) {
        const result = await check();
        if (result) return result;
        await delay(75);
    }
    throw Error('Timed out waiting for monitor state');
}

test('PostgreSQL migrations, worker leasing, deduplication, price history and resume', {
    skip: !databaseUrl && 'Set MONITOR_TEST_DATABASE_URL to run the isolated PostgreSQL test',
    timeout: 35000
}, async () => {
    const schema = 'monitor_test_' + randomBytes(8).toString('hex');
    const control = new Pool({ connectionString: databaseUrl });
    const pool = new Pool({ connectionString: databaseUrl, options: '-c search_path=' + schema });
    let services = [];
    const priorKey = process.env.MONITOR_ENCRYPTION_KEY;
    process.env.MONITOR_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    const tx = async fn => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    };

    try {
        await control.query('CREATE SCHEMA ' + schema);
        const base = await readFile(join(__dirname, '..', 'server', 'schema.sql'), 'utf8');
        await pool.query(base
            .replace("CONSTRAINT tasks_direction_monitor_check CHECK(direction IN ('selection','sale','rent'))", "CHECK(direction IN ('selection','sale'))")
            .replace("CONSTRAINT tasks_deal_monitor_check CHECK(deal IN ('buy','sell','rent'))", "CHECK(deal IN ('buy','sell'))"));
        await Promise.all([migrate(tx), migrate(tx)]);
        const { rows } = await pool.query(
            "INSERT INTO monitor_accounts(name,email,host,port,secure,username,auth_mode,folder,poll_seconds,enabled,secret) VALUES " +
            "('A','a@example.com','imap.gmail.com',993,true,'a@example.com','password','INBOX',30,true,'test')," +
            "('B','b@example.com','imap.gmail.com',993,true,'b@example.com','password','INBOX',30,true,'test') RETURNING id"
        );
        const [a, b] = rows.map(row => row.id);
        const email = await readFile(fixture, 'utf8');
        const seen = new Map([[a, []], [b, []]]);
        const clients = new Map();
        const attempts = new Map();
        const feed = new Map([[a, new Map()], [b, new Map()]]);
        const emitted = [];
        const earlier = new Date(Date.now() - 120000);
        const later = new Date(Date.now() - 60000);

        function enqueue(account, uid, source, received = earlier) {
            feed.get(account).set(uid, { source: Buffer.from(source), received });
            clients.get(account)?.emit('exists', { path: 'INBOX' });
        }

        function clientFactory({ id }) {
            assert.equal(clients.has(id), false, 'one socket per mailbox lease');
            const client = new EventEmitter();
            const messages = feed.get(id);
            client.connect = async () => {
                const attempt = (attempts.get(id) || 0) + 1;
                attempts.set(id, attempt);
                if (id === b && attempt === 1) throw Object.assign(Error('test timeout'), { code: 'ETIMEDOUT' });
                client.usable = true;
                clients.set(id, client);
            };
            client.close = () => {
                if (clients.get(id) === client) clients.delete(id);
                client.usable = false;
                client.emit('close');
            };
            client.mailbox = { uidValidity: 999n };
            client.mailboxOpen = async () => client.mailbox;
            client.status = async () => ({ uidValidity: 999n, uidNext: Math.max(0, ...messages.keys()) + 1 });
            client.search = async ({ uid }) => {
                const [from, to = from] = uid.split(':').map(Number);
                return [...messages.keys()].filter(value => value >= from && value <= to).reverse();
            };
            client.fetchOne = async (raw, fields) => {
                const uid = Number(raw);
                const message = messages.get(uid);
                if (!message) return false;
                if (fields.source) {
                    seen.get(id).push(uid);
                    return { source: message.source };
                }
                return { size: message.source.length, internalDate: message.received };
            };
            return client;
        }

        enqueue(a, 1, email);
        enqueue(a, 2, email);
        enqueue(a, 3, email.replace('alerts@avito.ru', 'forged@example.com'));
        const config = { pool, tx, emit: event => emitted.push(event), clientFactory };
        services = [createService(config), createService(config)];
        services.forEach(service => service.start());
        await waitFor(async () => (await pool.query('SELECT last_uid FROM monitor_accounts WHERE id=$1', [a])).rows[0].last_uid === '3');
        assert.equal((await stats(pool)).total, 2);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM monitor_emails WHERE status='done'")).rows[0].n, 1);
        await waitFor(() => attempts.get(b) === 2 && clients.has(b));
        enqueue(b, 1, email.replace('6 450 000', '6 000 000'), later);
        await waitFor(async () => (await stats(pool)).lowered === 1);
        const fromB = await listListings(pool, { account: b, search: 'Дома', min_price: '5000000' });
        assert.equal(fromB.listings.length, 1);
        assert.equal(fromB.listings[0].price, '6000000.00');
        const history = await pool.query('SELECT old_price,new_price FROM monitor_price_history');
        assert.deepEqual(history.rows, [{ old_price: '6450000.00', new_price: '6000000.00' }]);
        assert.equal((await stats(pool)).errors, 2);
        await waitFor(() => emitted.some(event => event.count === 2));

        await Promise.all(services.map(service => service.stop()));
        const before = [...seen.get(a)];
        enqueue(a, 4, email.replace('text-example', 'arrived-during-restart'), new Date());
        services = [createService(config)];
        services[0].start();
        await waitFor(async () => (await pool.query('SELECT last_uid FROM monitor_accounts WHERE id=$1', [a])).rows[0].last_uid === '4');
        assert.deepEqual(seen.get(a), [...before, 4]);
        const { rows: [counts] } = await pool.query('SELECT count(*)::int AS n FROM monitor_price_history');
        assert.equal(counts.n, 2);
        assert.equal((await stats(pool)).total, 2);
    } finally {
        await Promise.allSettled(services.map(service => service.stop()));
        if (priorKey === undefined) delete process.env.MONITOR_ENCRYPTION_KEY;
        else process.env.MONITOR_ENCRYPTION_KEY = priorKey;
        await pool.end();
        await control.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
        await control.end();
    }
});
