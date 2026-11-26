'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { validateAccount, buildClient, encryptSecret, encryptionKey, aad, trustedIds, errorCode, monitorError } = require('./connection');
const { parseMessage, MAX_MESSAGE_BYTES, listingLink } = require('./parser');
const { listAccounts, listListings, log, preferences, stats } = require('./store');

const actions = {
    view: 'is_new=false',
    favorite: 'favorite=true',
    unfavorite: 'favorite=false',
    archive: 'archived=true, is_new=false',
    restore: 'archived=false',
    delete: 'deleted_at=now(), is_new=false'
};
const errors = {
    credentials_unavailable: 'Не удалось прочитать сохранённые данные. Проверьте ключ шифрования.',
    host_blocked: 'Небезопасный или неразрешённый IMAP-сервер.',
    dns_failed: 'Не удалось определить адрес IMAP-сервера.',
    oauth_not_configured: 'На сервере не настроен OAuth для Gmail.',
    oauth_failed: 'Не удалось обновить токен Gmail. Проверьте настройки OAuth.',
    imap_auth_failed: 'Почтовый провайдер отклонил данные для входа.',
    imap_tls_failed: 'Не удалось установить защищённое соединение.',
    imap_timeout: 'Почтовый сервер не ответил вовремя.',
    imap_connection_reset: 'Соединение с IMAP было сброшено. Проверьте исходящий доступ к почтовому серверу на указанном порту.',
    imap_interface_unavailable: 'Сетевой адаптер для IMAP недоступен. Проверьте MONITOR_IMAP_INTERFACE и подключение адаптера.',
    mailbox_missing: 'Почтовая папка недоступна.',
    imap_unavailable: 'Не удалось связаться с IMAP-сервером.'
};

function identifier(value) {
    if (!/^[1-9]\d{0,14}$/.test(String(value))) throw monitorError(400, 'Некорректный идентификатор');
    return String(value);
}

function limiter(limit) {
    return rateLimit({
        windowMs: 60000, limit, keyGenerator: req => String(req.user.id), standardHeaders: true, legacyHeaders: false,
        message: { error: 'Слишком много запросов. Подождите минуту.' }
    });
}

async function accountById(c, id, lock = false) {
    const { rows: [row] } = await c.query('SELECT * FROM monitor_accounts WHERE id=$1 AND deleted_at IS NULL' + (lock ? ' FOR UPDATE' : ''), [id]);
    if (!row) throw monitorError(404, 'Почтовое подключение не найдено');
    return row;
}

function accountValues(settings) {
    return [settings.name, settings.email, settings.host, settings.port, settings.secure, settings.username,
        settings.auth_mode, settings.folder, settings.poll_seconds];
}

function getSecret(settings, saved) {
    if (settings.password) return encryptSecret(settings.password, settings);
    if (!saved || !aad(saved).equals(aad(settings))) throw monitorError(400, 'Введите пароль приложения или OAuth refresh token');
    return saved.secret;
}

async function writeAccount(tx, req) {
    const id = req.params.id && identifier(req.params.id);
    const settings = validateAccount(req.body);
    try {
        return await tx(async c => {
            const saved = id && await accountById(c, id, true);
            const cipher = getSecret(settings, saved);
            const values = [...accountValues(settings), cipher];
            let account = id;
            if (saved) {
                const changed = ['email','host','username','folder'].some(key => saved[key] !== settings[key]);
                await c.query(
                    "UPDATE monitor_accounts SET name=$1,email=$2,host=$3,port=$4,secure=$5,username=$6,auth_mode=$7,folder=$8,poll_seconds=$9,secret=$10, " +
                    'revision=revision+1, status=CASE WHEN enabled THEN \'connecting\' ELSE \'stopped\' END, next_check_at=NULL, ' +
                    'mailbox_epoch=mailbox_epoch+CASE WHEN $11 THEN 1 ELSE 0 END, uid_validity=CASE WHEN $11 THEN NULL ELSE uid_validity END, ' +
                    'last_uid=CASE WHEN $11 THEN 0 ELSE last_uid END WHERE id=$12',
                    [...values, changed, id]
                );
            } else {
                const { rows: [row] } = await c.query(
                    'INSERT INTO monitor_accounts(name,email,host,port,secure,username,auth_mode,folder,poll_seconds,secret) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
                    values
                );
                account = row.id;
            }
            await log(c, { account, actor: req.user.id, code: saved ? 'account_updated' : 'account_created' });
            return account;
        });
    } catch (error) {
        if (error.code === '23505') throw monitorError(409, 'Эта почтовая папка уже подключена');
        throw error;
    }
}

function parseTaskOptions(body) {
    const listingId = body.monitor_listing_id == null || body.monitor_listing_id === '' ? null : identifier(body.monitor_listing_id);
    if (!listingId) return null;
    const url = body.monitor_url ? listingLink(body.monitor_url)?.url : null;
    if (body.monitor_url && !url) throw monitorError(400, 'Укажите прямую защищённую ссылку на объявление Авито');
    const description = typeof body.monitor_description === 'string' ? body.monitor_description.trim().slice(0, 2000) || null : null;
    const price = body.monitor_price == null || body.monitor_price === '' ? null : String(body.monitor_price);
    if (price !== null && !/^\d{1,14}(?:\.\d{1,2})?$/.test(price)) throw monitorError(400, 'Укажите корректную стоимость объявления');
    return { listingId, url, description, price };
}

async function lockListingForTask(c, id) {
    const { rowCount } = await c.query('SELECT id FROM monitor_listings WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!rowCount) throw monitorError(404, 'Объявление недоступно');
    const { rows: [linked] } = await c.query('SELECT task_id FROM monitor_task_details WHERE listing_id=$1', [id]);
    if (linked) throw monitorError(409, 'Для этого объявления уже создана задача №' + linked.task_id);
}

async function linkTask(c, taskId, options, actor) {
    await c.query('INSERT INTO monitor_task_details(task_id,listing_id,url,description,price) VALUES ($1,$2,$3,$4,$5)',
        [taskId, options.listingId, options.url, options.description, options.price]);
    await c.query('UPDATE monitor_listings SET is_new=false WHERE id=$1', [options.listingId]);
    await log(c, { actor, code: 'task_created' });
}

function router({ pool, tx, service }) {
    const routes = express.Router();

    routes.get('/state', async (req, res) => {
        const [metrics, { rows: [settings] }] = await Promise.all([
            stats(pool), pool.query('SELECT toast,sound,desktop FROM monitor_settings WHERE user_id=$1', [req.user.id])
        ]);
        res.json({ stats: metrics, preferences: settings || preferences });
    });

    routes.put('/preferences', async (req, res) => {
        const { toast, sound, desktop } = req.body || {};
        if (![toast, sound, desktop].every(value => typeof value === 'boolean')) throw monitorError(400, 'Некорректные настройки');
        await tx(async c => {
            await c.query('INSERT INTO monitor_settings(user_id,toast,sound,desktop) VALUES ($1,$2,$3,$4) ' +
                'ON CONFLICT (user_id) DO UPDATE SET toast=$2,sound=$3,desktop=$4', [req.user.id, toast, sound, desktop]);
            await log(c, { actor: req.user.id, code: 'preferences_updated' });
        });
        res.json({ toast, sound, desktop });
    });

    routes.get('/accounts', async (req, res) => {
        const [accounts, { rows: logs }, { rows: filterAccounts }] = await Promise.all([
            listAccounts(pool),
            pool.query('SELECT l.id,l.account_id,a.name,l.level,l.code,l.uid,l.created_at FROM monitor_logs l ' +
                'LEFT JOIN monitor_accounts a ON a.id=l.account_id ORDER BY l.id DESC LIMIT 60'),
            pool.query('SELECT a.id,a.name FROM monitor_accounts a WHERE a.deleted_at IS NULL OR ' +
                'EXISTS (SELECT 1 FROM monitor_listing_sources s WHERE s.account_id=a.id) ORDER BY a.name,a.id')
        ]);
        res.json({ accounts, logs, filterAccounts, encryptionReady: !!encryptionKey(),
            googleOAuth: !!(process.env.MONITOR_GOOGLE_CLIENT_ID && process.env.MONITOR_GOOGLE_CLIENT_SECRET) });
    });

    const save = async (req, res) => {
        const id = await writeAccount(tx, req);
        void service.refresh();
        service.notify();
        res.status(req.params.id ? 200 : 201).json({ id });
    };
    routes.post('/accounts', save);
    routes.patch('/accounts/:id', save);

    routes.post('/accounts/test', limiter(5), async (req, res) => {
        const settings = validateAccount(req.body);
        const saved = req.body.id ? await accountById(pool, identifier(req.body.id)) : null;
        const cipher = getSecret(settings, saved);
        let client;
        try {
            client = await buildClient({ ...settings, secret: cipher });
            client.on('error', () => {});
            await client.connect();
            if (!await client.mailboxOpen(settings.folder, { readOnly: true })) {
                throw Object.assign(Error(), { monitorCode: 'mailbox_missing' });
            }
        } catch (error) {
            const code = errorCode(error);
            await log(pool, { account: saved?.id, actor: req.user.id, level: 'error', code });
            throw monitorError(400, errors[code] || errors.imap_unavailable);
        } finally {
            client?.close();
        }
        await log(pool, { account: saved?.id, actor: req.user.id, code: 'connection_tested' });
        res.json({ ok: true });
    });

    routes.post('/accounts/:id/:action', limiter(12), async (req, res) => {
        const id = identifier(req.params.id);
        const action = req.params.action;
        if (!['start', 'stop', 'check'].includes(action)) throw monitorError(404, 'Действие не найдено');
        if (action !== 'stop' && !encryptionKey()) throw monitorError(503, 'На сервере требуется ключ MONITOR_ENCRYPTION_KEY');
        await tx(async c => {
            const account = await accountById(c, id, true);
            if (action === 'check') {
                if (!account.enabled) throw monitorError(409, 'Сначала запустите мониторинг этого ящика');
                const result = await c.query("UPDATE monitor_accounts SET check_requested_at=now() WHERE id=$1 " +
                    "AND (check_requested_at IS NULL OR check_requested_at<=now()-interval '30 seconds')", [id]);
                if (!result.rowCount) throw monitorError(429, 'Повторите проверку через 30 секунд');
            } else {
                const enabled = action === 'start';
                if (account.enabled !== enabled) {
                    await c.query('UPDATE monitor_accounts SET enabled=$2,status=$3,revision=revision+1,next_check_at=NULL WHERE id=$1',
                        [id, enabled, enabled ? 'connecting' : 'stopped']);
                }
            }
            await log(c, { account: id, actor: req.user.id, code: 'account_' + action });
        });
        void service.refresh();
        service.notify();
        res.json({ ok: true });
    });

    routes.delete('/accounts/:id', async (req, res) => {
        const id = identifier(req.params.id);
        await tx(async c => {
            await accountById(c, id, true);
            await c.query("UPDATE monitor_accounts SET enabled=false, secret='', status='stopped', revision=revision+1, deleted_at=now(), next_check_at=NULL WHERE id=$1", [id]);
            await log(c, { account: id, actor: req.user.id, code: 'account_deleted' });
        });
        void service.refresh();
        service.notify();
        res.json({ ok: true });
    });

    routes.post('/preview', limiter(6), express.raw({ type: 'application/octet-stream', limit: MAX_MESSAGE_BYTES }), async (req, res) => {
        try {
            const ids = [...new Set(['imap.gmail.com','imap.yandex.ru','imap.mail.ru'].flatMap(trustedIds))];
            const { messageId, ...preview } = await parseMessage(req.body, ids);
            res.json(preview);
        } catch (error) {
            await log(pool, { actor: req.user.id, level: 'error', code: error.code === 'invalid_size' ? 'invalid_size' : 'parse_failed' });
            throw monitorError(400, 'Не удалось разобрать письмо. Выберите файл .eml размером до 1 МБ.');
        }
    });

    routes.get('/listings', async (req, res) => res.json(await listListings(pool, req.query)));
    routes.get('/listings/:id', async (req, res) => {
        const id = identifier(req.params.id);
        const { rows: [listing] } = await pool.query('SELECT * FROM monitor_listings WHERE id=$1 AND deleted_at IS NULL', [id]);
        if (!listing) throw monitorError(404, 'Объявление не найдено');
        const [history, sources] = await Promise.all([
            pool.query('SELECT old_price,new_price,changed_at FROM monitor_price_history WHERE listing_id=$1 ORDER BY id DESC LIMIT 100', [id]),
            pool.query('SELECT a.name,s.search_name,s.last_received_at FROM monitor_listing_sources s JOIN monitor_accounts a ON a.id=s.account_id WHERE s.listing_id=$1 ORDER BY s.last_received_at DESC LIMIT 100', [id])
        ]);
        res.json({ listing, history: history.rows, sources: sources.rows });
    });
    routes.patch('/listings/:id', async (req, res) => {
        const id = identifier(req.params.id);
        const { action } = req.body || {};
        if (!Object.hasOwn(actions, action)) throw monitorError(400, 'Неизвестное действие');
        await tx(async c => {
            const { rowCount } = await c.query('UPDATE monitor_listings SET ' + actions[action] + ' WHERE id=$1 AND deleted_at IS NULL', [id]);
            if (!rowCount) throw monitorError(404, 'Объявление не найдено');
            if (action !== 'view') await log(c, { actor: req.user.id, code: 'listing_' + action });
        });
        service.notify(0, true);
        res.json({ ok: true });
    });

    return routes;
}

module.exports = { router, parseTaskOptions, lockListingForTask, linkTask };
