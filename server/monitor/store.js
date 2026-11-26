'use strict';

const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { monitorError } = require('./connection');

const listingFields = [
    'external_id', 'url', 'photo_url', 'title', 'description', 'price', 'category', 'deal',
    'city', 'district', 'address', 'area', 'rooms', 'seller_type', 'seller_name', 'published_at'
];
const accountFields = 'id, name, email, host, port, secure, username, auth_mode, folder, poll_seconds, enabled, status, last_check_at, last_message_at, next_check_at';
const preferences = { toast: true, sound: false, desktop: true };

async function migrate(tx) {
    const sql = await readFile(join(__dirname, 'schema.sql'), 'utf8');
    await tx(async c => {
        await c.query('SELECT pg_advisory_xact_lock(74206, 1)');
        await c.query(sql);
    });
}

function log(c, { account = null, actor = null, level = 'info', code, uid = null }) {
    return c.query('INSERT INTO monitor_logs(account_id, actor_id, level, code, uid) VALUES ($1,$2,$3,$4,$5)',
        [account, actor, level, code, uid]);
}

function advance(c, accountId, validity, uid) {
    return c.query('UPDATE monitor_accounts SET uid_validity=$2, last_uid=GREATEST(last_uid,$3) WHERE id=$1',
        [accountId, validity, uid]);
}

async function lockLease(c, account) {
    const { rowCount } = await c.query(
        'SELECT id FROM monitor_accounts WHERE id=$1 AND enabled AND deleted_at IS NULL AND revision=$2 AND lease_owner=$3 AND lease_until>now() FOR UPDATE',
        [account.id, account.revision, account.lease_owner]
    );
    if (!rowCount) throw Object.assign(Error('lease_lost'), { monitorCode: 'lease_lost' });
}

async function upsertListing(c, listing, accountId, receivedAt, searchName) {
    const fields = listingFields.map(name => listing[name] ?? null);
    const { rows: [existing] } = await c.query(
        'SELECT * FROM monitor_listings WHERE source=$1 AND (external_id=$2 OR url=$3) ORDER BY (external_id IS NOT DISTINCT FROM $2) DESC LIMIT 1 FOR UPDATE',
        [listing.source, listing.external_id, listing.url]
    );
    let listingId = existing?.id;
    if (existing) {
        const fresh = +receivedAt >= +existing.details_received_at;
        if (fresh && existing.price !== null && listing.price != null && Number(existing.price) !== listing.price) {
            await c.query(
                'INSERT INTO monitor_price_history (listing_id, old_price, new_price, changed_at) VALUES ($1,$2,$3,$4)',
                [listingId, existing.price, listing.price, receivedAt]
            );
            await c.query('UPDATE monitor_listings SET previous_price=price WHERE id=$1', [listingId]);
        }
        const assignments = listingFields.map((name, index) => {
            const binding = '$' + (index + 4);
            return name + (fresh ? '=COALESCE(' + binding + ',' + name + ')' : '=COALESCE(' + name + ',' + binding + ')');
        });
        await c.query(
            'UPDATE monitor_listings SET first_received_at=LEAST(first_received_at,$2), last_received_at=GREATEST(last_received_at,$2), ' +
            'details_received_at=GREATEST(details_received_at,$3), ' + assignments.join(', ') + ' WHERE id=$1',
            [listingId, receivedAt, receivedAt, ...fields]
        );
    } else {
        const bindings = fields.map((_, index) => '$' + (index + 3)).join(', ');
        const { rows: [created] } = await c.query(
            'INSERT INTO monitor_listings (source,first_received_at,last_received_at,details_received_at,' + listingFields.join(',') +
            ') VALUES ($1,$2,$2,$2,' + bindings + ') RETURNING id',
            [listing.source, receivedAt, ...fields]
        );
        listingId = created.id;
    }
    await c.query(
        'INSERT INTO monitor_listing_sources (listing_id,account_id,search_name,last_received_at) VALUES ($1,$2,$3,$4) ' +
        'ON CONFLICT (listing_id,account_id,search_name) DO UPDATE SET last_received_at=GREATEST(monitor_listing_sources.last_received_at, EXCLUDED.last_received_at)',
        [listingId, accountId, searchName || '', receivedAt]
    );
    return !existing;
}

async function storeMessage(tx, account, validity, uid, receivedAt, parsed, error) {
    return tx(async c => {
        await lockLease(c, account);
        const accepted = parsed?.authentication === 'verified';
        const hash = accepted && parsed.messageId ? createHash('sha256').update(parsed.messageId).digest('hex') : null;
        const status = error || (parsed && !accepted) ? 'error' : accepted ? 'done' : 'ignored';
        const { rowCount } = await c.query(
            'INSERT INTO monitor_emails (account_id,mailbox_epoch,uid_validity,uid,message_id_hash,received_at,status) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
            [account.id, account.mailbox_epoch, validity, uid, hash, receivedAt, status]
        );
        let created = 0;
        if (rowCount) {
            if (error || (parsed && !accepted)) {
                await log(c, { account: account.id, level: 'error', code: error || parsed.authentication, uid });
            }
            if (accepted && !parsed.listings.length) await log(c, { account: account.id, level: 'error', code: 'no_listings', uid });
            if (accepted && parsed.listings.length) {
                await c.query('SELECT pg_advisory_xact_lock(74206, 2)');
                for (const listing of parsed.listings) {
                    created += Number(await upsertListing(c, listing, account.id, receivedAt, parsed.search_name));
                }
            }
            await c.query('UPDATE monitor_accounts SET last_message_at=GREATEST(last_message_at,$2) WHERE id=$1',
                [account.id, receivedAt]);
        }
        await advance(c, account.id, validity, uid);
        return created;
    });
}

async function listAccounts(pool) {
    const { rows } = await pool.query(
        'SELECT ' + accountFields.split(', ').map(field => 'a.' + field).join(', ') +
        ", (SELECT count(*)::int FROM monitor_emails e WHERE e.account_id=a.id AND e.status='done') AS processed " +
        ', a.check_requested_at>a.check_handled_at OR (a.check_requested_at IS NOT NULL AND a.check_handled_at IS NULL) AS pending_check ' +
        'FROM monitor_accounts a WHERE a.deleted_at IS NULL ORDER BY a.id'
    );
    return rows;
}

async function stats(pool) {
    const { rows: [row] } = await pool.query(
        "SELECT count(*) FILTER (WHERE is_new AND NOT archived)::int AS unread, " +
        "count(*) FILTER (WHERE first_received_at >= (date_trunc('day',now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'))::int AS today, " +
        "count(*) FILTER (WHERE first_received_at >= now()-interval '7 days')::int AS week, count(*)::int AS total, " +
        "count(*) FILTER (WHERE l.seller_type='owner')::int AS owners, count(*) FILTER (WHERE l.price<l.previous_price)::int AS lowered, " +
        'count(t.task_id)::int AS assigned, (SELECT count(*)::int FROM monitor_logs WHERE level=\'error\') AS errors ' +
        'FROM monitor_listings l LEFT JOIN monitor_task_details t ON t.listing_id=l.id WHERE l.deleted_at IS NULL'
    );
    return row;
}

function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value);
    return !Number.isNaN(+date) && date.toISOString().slice(0, 10) === value && value.slice(0, 4) !== '0000';
}

function listingQuery(filters) {
    const values = [];
    const clauses = ['l.deleted_at IS NULL'];
    const bind = value => '$' + values.push(value);
    const tabs = { new: 'l.is_new AND NOT l.archived', favorites: 'l.favorite AND NOT l.archived',
        assigned: 'd.task_id IS NOT NULL AND NOT l.archived', archived: 'l.archived', all: 'NOT l.archived' };
    const tab = Object.hasOwn(tabs, filters.tab) ? filters.tab : 'all';
    if (!(tab === 'all' && filters.status === 'archived')) clauses.push(tabs[tab]);
    const statuses = { new: 'l.is_new AND NOT l.archived AND d.task_id IS NULL', viewed: 'NOT l.is_new AND NOT l.archived AND d.task_id IS NULL',
        assigned: 'd.task_id IS NOT NULL', archived: 'l.archived' };
    if (Object.hasOwn(statuses, filters.status)) clauses.push(statuses[filters.status]);

    function string(key, limit = 180) {
        return typeof filters[key] === 'string' ? filters[key].trim().slice(0, limit) : '';
    }
    const q = string('q');
    if (q) clauses.push("strpos(lower(concat_ws(' ', l.title, l.address, l.description)), lower(" + bind(q) + ')) > 0');
    for (const key of ['city', 'district']) {
        if (string(key)) clauses.push('strpos(lower(l.' + key + '), lower(' + bind(string(key)) + ')) > 0');
    }
    for (const key of ['source', 'category', 'deal', 'seller_type']) {
        if (!string(key)) continue;
        clauses.push('l.' + key + (filters[key] === 'unknown' ? ' IS NULL' : '=' + bind(string(key))));
    }
    const accountId = string('account');
    const search = string('search');
    if (accountId || search) {
        if (accountId && !/^[1-9]\d{0,14}$/.test(accountId)) throw monitorError(400, 'Некорректный ящик');
        const found = ['s.listing_id=l.id'];
        if (accountId) found.push('s.account_id=' + bind(accountId));
        if (search) found.push('strpos(lower(s.search_name),lower(' + bind(search) + '))>0');
        clauses.push('EXISTS (SELECT 1 FROM monitor_listing_sources s WHERE ' + found.join(' AND ') + ')');
    }
    if (string('owner')) {
        if (!/^[1-9]\d{0,14}$/.test(filters.owner)) throw monitorError(400, 'Некорректный сотрудник');
        clauses.push('t.owner_id=' + bind(filters.owner));
    }
    for (const [input, column, op] of [['rooms','rooms','='], ['min_price','price','>='], ['max_price','price','<='],
        ['min_area','area','>='], ['max_area','area','<=']]) {
        if (!string(input)) continue;
        if (!/^\d{1,14}(?:\.\d{1,2})?$/.test(filters[input])) throw monitorError(400, 'Некорректный числовой фильтр');
        clauses.push('l.' + column + op + bind(filters[input]) + '::numeric');
    }
    if (string('date')) {
        if (!validDate(filters.date)) throw monitorError(400, 'Некорректная дата');
        clauses.push("(l.last_received_at AT TIME ZONE 'Europe/Moscow')::date=" + bind(filters.date) + '::date');
    }
    return { where: clauses.join(' AND '), values };
}

async function listListings(pool, filters) {
    const { where, values } = listingQuery(filters);
    const offset = Number(filters.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw monitorError(400, 'Некорректная страница');
    const { rows } = await pool.query(
        'SELECT l.*, d.task_id, t.deleted_at AS task_deleted_at, u.name AS owner_name ' +
        'FROM monitor_listings l LEFT JOIN monitor_task_details d ON d.listing_id=l.id ' +
        'LEFT JOIN tasks t ON t.id=d.task_id LEFT JOIN users u ON u.id=t.owner_id WHERE ' + where +
        ' ORDER BY l.is_new DESC, l.last_received_at DESC, l.id DESC LIMIT 31 OFFSET $' + (values.length + 1),
        [...values, offset]
    );
    return { listings: rows.slice(0, 30), more: rows.length > 30 };
}

module.exports = { migrate, log, advance, lockLease, storeMessage, listAccounts, stats, listListings, listingQuery,
    validDate, preferences };
