'use strict';

const { randomUUID } = require('node:crypto');
const { buildClient, encryptionKey, errorCode, trustedIds } = require('./connection');
const { parseMessage, MAX_MESSAGE_BYTES } = require('./parser');
const { advance, lockLease, log, storeMessage } = require('./store');

const HEARTBEAT_MS = 5000;
const BATCH_SIZE = 100;
const FIRST_SCAN_MS = 7 * 86400000;

function retryDelay(attempt) {
    return Math.min(300000, 5000 * 2 ** Math.min(attempt - 1, 6));
}

function timestamp(value) {
    const date = new Date(value);
    return value && !Number.isNaN(+date) ? +date : 0;
}

async function checkMailbox(client, account, tx, notify) {
    let info = await client.status(account.folder, { uidNext: true, uidValidity: true });
    if (info.uidValidity && client.mailbox.uidValidity && String(info.uidValidity) !== String(client.mailbox.uidValidity)) {
        info = await client.mailboxOpen(account.folder, { readOnly: true });
    }
    const validity = String(info.uidValidity ?? client.mailbox.uidValidity);
    const upper = Number(info.uidNext) - 1;
    if (!/^[1-9]\d{0,10}$/.test(validity) || !Number.isSafeInteger(upper) || upper < 0) {
        throw Object.assign(Error('invalid_mailbox'), { monitorCode: 'invalid_mailbox' });
    }
    if (validity !== String(account.uid_validity)) {
        await tx(async c => {
            await lockLease(c, account);
            await c.query('UPDATE monitor_accounts SET uid_validity=$2, last_uid=0 WHERE id=$1', [account.id, validity]);
        });
        account.uid_validity = validity;
        account.last_uid = 0;
    }
    const cursor = Number(account.last_uid);
    if (upper <= cursor) return false;
    const search = { uid: (cursor + 1) + ':' + upper, from: 'avito.ru' };
    if (!cursor) search.since = new Date(Date.now() - FIRST_SCAN_MS);
    const matches = await client.search(search, { uid: true });
    if (!Array.isArray(matches)) throw Object.assign(Error('imap_search_failed'), { monitorCode: 'imap_search_failed' });
    const uids = [...new Set(matches)].filter(uid => Number.isSafeInteger(uid) && uid > cursor && uid <= upper).sort((a, b) => a - b);
    for (const uid of uids.slice(0, BATCH_SIZE)) {
        const metadata = await fetchMessage(client, uid, { size: true, internalDate: true });
        if (!metadata) continue;
        const receivedAt = timestamp(metadata.internalDate) ? new Date(metadata.internalDate) : new Date();
        let parsed;
        let problem;
        if (metadata.size > MAX_MESSAGE_BYTES) problem = 'invalid_size';
        else {
            const message = await fetchMessage(client, uid, { source: { start: 0, maxLength: MAX_MESSAGE_BYTES + 1 } });
            if (!message) continue;
            try {
                parsed = await parseMessage(message.source, trustedIds(account.host));
            } catch (error) {
                problem = error.code === 'invalid_size' ? 'invalid_size' : 'parse_failed';
            }
        }
        const count = await storeMessage(tx, account, validity, uid, receivedAt, parsed, problem);
        account.last_uid = uid;
        notify(count);
    }
    const more = uids.length > BATCH_SIZE;
    const newCursor = more ? uids[BATCH_SIZE - 1] : upper;
    await tx(async c => {
        await lockLease(c, account);
        await advance(c, account.id, validity, newCursor);
    });
    account.last_uid = newCursor;
    return more;
}

async function fetchMessage(client, uid, fields) {
    const result = await client.fetchOne(String(uid), fields, { uid: true });
    if (result) return result;
    const remaining = await client.search({ uid: String(uid) }, { uid: true });
    if (Array.isArray(remaining) && !remaining.includes(uid)) return null;
    throw Object.assign(Error('imap_fetch_failed'), { monitorCode: 'imap_fetch_failed' });
}

function createService({ pool, tx, emit, clientFactory = buildClient }) {
    const workers = new Map();
    const instance = randomUUID();
    let stopped = true;
    let ticker;
    let reconciling;
    let emitTimer;
    let additions = 0;
    let dataChanged = false;
    let requested = false;

    function notify(newListings = 0, listingsChanged = false) {
        if (stopped) return;
        additions += newListings;
        dataChanged ||= listingsChanged;
        if (emitTimer) return;
        emitTimer = setTimeout(() => {
            emit({ count: additions, listings: dataChanged });
            emitTimer = null;
            additions = 0;
            dataChanged = false;
        }, 1500);
        emitTimer.unref();
    }

    async function status(worker, state, { checked = false, next = null, code = null } = {}) {
        const { account } = worker;
        await tx(async c => {
            await lockLease(c, account);
            await c.query(
                'UPDATE monitor_accounts SET status=$2, next_check_at=$3, last_check_at=CASE WHEN $4 THEN now() ELSE last_check_at END, ' +
                'check_handled_at=CASE WHEN $4 THEN GREATEST(check_handled_at,$5::timestamptz) ELSE check_handled_at END WHERE id=$1',
                [account.id, state, next, checked, worker.currentRequest || null]
            );
            if (code) await log(c, { account: account.id, level: 'error', code });
        });
        notify();
    }

    function arm(worker, delay) {
        clearTimeout(worker.timer);
        if (worker.stopped || stopped) return;
        worker.timer = setTimeout(() => run(worker), delay);
        worker.timer.unref();
    }

    function wake(worker) {
        worker.pending = true;
        if (!worker.running && !worker.failures) arm(worker, 0);
    }

    async function connect(worker) {
        await status(worker, worker.failures ? 'reconnecting' : 'connecting');
        const client = await clientFactory(worker.account);
        if (worker.stopped || stopped) {
            client.close();
            throw Object.assign(Error('lease_lost'), { monitorCode: 'lease_lost' });
        }
        worker.client = client;
        client.on('error', () => {});
        client.on('close', () => {
            if (client !== worker.client) return;
            worker.client = null;
            if (worker.running) worker.pending = true;
            else {
                const error = Object.assign(Error('imap_connection_lost'), { monitorCode: 'imap_connection_lost' });
                worker.running = recover(worker, error).finally(() => { worker.running = null; });
            }
        });
        client.on('exists', event => {
            if (event.path === worker.account.folder) wake(worker);
        });
        await client.connect();
        if (!await client.mailboxOpen(worker.account.folder, { readOnly: true })) {
            throw Object.assign(Error('mailbox_missing'), { monitorCode: 'mailbox_missing' });
        }
        return client;
    }

    function closeClient(worker) {
        const client = worker.client;
        worker.client = null;
        client?.close();
    }

    async function check(worker) {
        if (worker.stopped || stopped) return;
        worker.pending = false;
        worker.currentRequest = worker.latestRequest;
        const client = worker.client?.usable ? worker.client : await connect(worker);
        const more = await checkMailbox(client, worker.account, tx, count => notify(count, true));
        worker.failures = 0;
        const delay = more || worker.pending ? 100 : worker.account.poll_seconds * 1000;
        await status(worker, 'active', { checked: true, next: new Date(Date.now() + delay) });
        arm(worker, worker.pending ? 100 : delay);
    }

    async function recover(worker, error) {
        closeClient(worker);
        if (error.monitorCode === 'lease_lost' || worker.stopped || stopped) return;
        worker.failures += 1;
        const delay = retryDelay(worker.failures);
        const code = errorCode(error);
        const state = ['imap_auth_failed','imap_tls_failed','credentials_unavailable','host_blocked','oauth_failed',
            'oauth_not_configured','mailbox_missing','imap_interface_unavailable'].includes(code) ? 'error' : 'reconnecting';
        try {
            await status(worker, state, { next: new Date(Date.now() + delay), code });
        } catch {
            // Reconciliation still checks the lease if PostgreSQL is temporarily unavailable.
        }
        arm(worker, delay);
    }

    function run(worker) {
        if (worker.running || worker.stopped || stopped) return;
        worker.running = check(worker).catch(error => recover(worker, error)).finally(() => { worker.running = null; });
    }

    async function release(worker) {
        worker.stopped = true;
        clearTimeout(worker.timer);
        closeClient(worker);
        await worker.running;
        try {
            await pool.query(
                "UPDATE monitor_accounts SET lease_owner=NULL, lease_until=NULL, status=CASE WHEN enabled THEN 'reconnecting' ELSE 'stopped' END, next_check_at=NULL " +
                'WHERE id=$1 AND lease_owner=$2',
                [worker.account.id, instance]
            );
        } finally {
            workers.delete(String(worker.account.id));
            notify();
        }
    }

    async function reconcile() {
        if (stopped || !encryptionKey()) return;
        const { rows } = await pool.query(
            'SELECT id, revision, check_requested_at, check_handled_at FROM monitor_accounts WHERE enabled AND deleted_at IS NULL'
        );
        const enabled = new Map(rows.map(row => [String(row.id), row]));
        for (const [id, worker] of workers) {
            const row = enabled.get(id);
            if (!row || row.revision !== worker.account.revision) {
                await release(worker);
                continue;
            }
            const renewal = await pool.query(
                "UPDATE monitor_accounts SET lease_until=now()+interval '35 seconds' WHERE id=$1 AND lease_owner=$2 AND revision=$3 AND lease_until>now()",
                [id, instance, row.revision]
            );
            if (!renewal.rowCount) {
                await release(worker);
                continue;
            }
            if (timestamp(row.check_requested_at) > timestamp(worker.latestRequest)) {
                worker.latestRequest = row.check_requested_at;
                if (!worker.running) arm(worker, 0);
                else wake(worker);
            }
        }
        // Release is conditional on the instance UUID; each worker is leased before dialing.
        for (const [id] of enabled) {
            if (stopped || workers.has(id)) continue;
            const { rows: [account] } = await pool.query(
                "UPDATE monitor_accounts SET lease_owner=$2, lease_until=now()+interval '35 seconds' WHERE id=$1 AND enabled AND deleted_at IS NULL " +
                'AND (lease_until IS NULL OR lease_until<=now()) RETURNING *',
                [id, instance]
            );
            if (!account) continue;
            const worker = { account, pending: false, failures: 0, latestRequest: account.check_requested_at };
            workers.set(id, worker);
            arm(worker, 0);
        }
    }

    function refresh() {
        if (stopped) return Promise.resolve();
        if (reconciling) {
            requested = true;
            return reconciling;
        }
        reconciling = reconcile().catch(async () => {
            await Promise.allSettled([...workers.values()].map(release));
        }).finally(() => {
            reconciling = null;
            if (requested) {
                requested = false;
                void refresh();
            }
        });
        return reconciling;
    }

    function start() {
        if (!stopped) return;
        stopped = false;
        ticker = setInterval(refresh, HEARTBEAT_MS);
        ticker.unref();
        void refresh();
    }

    async function stop() {
        stopped = true;
        clearInterval(ticker);
        clearTimeout(emitTimer);
        emitTimer = null;
        additions = 0;
        dataChanged = false;
        await reconciling;
        await Promise.allSettled([...workers.values()].map(release));
    }

    return { start, refresh, notify, stop };
}

module.exports = { createService, checkMailbox, retryDelay };
