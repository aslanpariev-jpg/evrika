'use strict';

const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { lookup } = require('node:dns/promises');
const { networkInterfaces } = require('node:os');
const ipaddr = require('ipaddr.js');
const { ImapFlow } = require('imapflow');
const { MAX_MESSAGE_BYTES } = require('./parser');

const providers = {
    'imap.gmail.com': ['mx.google.com'],
    'imap.yandex.ru': ['mx.yandex.ru', 'yandex.ru', 'mail.yandex.ru'],
    'imap.mail.ru': ['mxs.mail.ru', 'mx.mail.ru', 'mail.ru']
};
const commaList = value => String(value || '').toLowerCase().split(',').map(item => item.trim()).filter(Boolean);
const monitorError = (status, message) => Object.assign(Error(message), { status });
const connectionError = code => Object.assign(Error(code), { monitorCode: code });

function encryptionKey() {
    const value = process.env.MONITOR_ENCRYPTION_KEY || '';
    if (!/^[a-zA-Z0-9+/]{43}=$/.test(value)) return null;
    const key = Buffer.from(value, 'base64');
    return key.length === 32 && key.toString('base64') === value ? key : null;
}

function validateAccount(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw monitorError(400, 'Укажите настройки подключения');
    const read = (name, max, optional = false) => {
        const value = body[name];
        if (optional && (value === '' || value == null)) return null;
        if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
            throw monitorError(400, 'Некорректные настройки подключения');
        }
        return name === 'password' ? value : value.trim();
    };
    const host = read('host', 253).toLowerCase();
    const email = read('email', 254).toLowerCase();
    let folder = read('folder', 150);
    if (folder.toLowerCase() === 'inbox') folder = 'INBOX';
    const port = Number(body.port);
    const poll_seconds = Number(body.poll_seconds ?? 60);
    const auth_mode = body.auth_mode || 'password';
    if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email) ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i.test(host) ||
        ![143, 993].includes(port) || typeof body.secure !== 'boolean' || body.secure !== (port === 993) ||
        !Number.isInteger(poll_seconds) || poll_seconds < 30 || poll_seconds > 3600) {
        throw monitorError(400, 'Проверьте адрес почты, IMAP-сервер, порт и интервал проверки');
    }
    if (!Object.hasOwn(providers, host) && !commaList(process.env.MONITOR_IMAP_HOSTS).includes(host)) {
        throw monitorError(400, 'IMAP-сервер не входит в разрешённый список MONITOR_IMAP_HOSTS');
    }
    if (auth_mode !== 'password' && (auth_mode !== 'google-oauth' || host !== 'imap.gmail.com')) {
        throw monitorError(400, 'Этот способ OAuth доступен для Gmail');
    }
    return { name: read('name', 120), email, host, port, secure: body.secure, username: read('username', 254),
        auth_mode, folder, poll_seconds, password: read('password', 4096, true) };
}

function aad(account) {
    return Buffer.from(JSON.stringify([account.email, account.host, account.port, account.username, account.auth_mode]));
}

function encryptSecret(value, account, key = encryptionKey()) {
    if (!key) throw monitorError(503, 'На сервере требуется ключ MONITOR_ENCRYPTION_KEY');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(account));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

function decryptSecret(value, account, key = encryptionKey()) {
    try {
        if (!key) throw Error();
        const payload = Buffer.from(value, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
        decipher.setAAD(aad(account));
        decipher.setAuthTag(payload.subarray(12, 28));
        return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
        throw connectionError('credentials_unavailable');
    }
}

function isPublicAddress(value) {
    try {
        const address = ipaddr.process(value);
        return address.range() === 'unicast' &&
            (address.kind() === 'ipv4' || address.match(ipaddr.parse('2000::'), 3));
    } catch {
        return false;
    }
}

function interfaceAddresses(name, interfaces = networkInterfaces()) {
    const addresses = {};
    for (const entry of interfaces[name] || []) {
        if (entry.internal) continue;
        const address = ipaddr.parse(entry.address);
        if (address.kind() === 'ipv4' && ['unicast', 'private'].includes(address.range())) {
            addresses[4] ??= entry.address;
        }
        if (address.kind() === 'ipv6' && address.range() === 'unicast' && isPublicAddress(entry.address)) {
            addresses[6] ??= entry.address;
        }
    }
    if (!addresses[4] && !addresses[6]) throw connectionError('imap_interface_unavailable');
    return addresses;
}

async function resolveImapHost(host, resolve = lookup, localAddresses) {
    if (!Object.hasOwn(providers, host) && !commaList(process.env.MONITOR_IMAP_HOSTS).includes(host)) {
        throw connectionError('host_blocked');
    }
    let timeout;
    try {
        const addresses = await Promise.race([
            resolve(host, { all: true }),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(connectionError('dns_failed')), 5000); })
        ]);
        if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
            throw connectionError('host_blocked');
        }
        const compatible = localAddresses ? addresses.filter(item => localAddresses[item.family]) : addresses;
        if (!compatible.length) throw connectionError('imap_interface_unavailable');
        return compatible.find(item => item.family === 4)?.address || compatible[0].address;
    } catch (error) {
        throw error.monitorCode ? error : connectionError('dns_failed');
    } finally {
        clearTimeout(timeout);
    }
}

async function googleAccessToken(secret) {
    const { MONITOR_GOOGLE_CLIENT_ID: client_id, MONITOR_GOOGLE_CLIENT_SECRET: client_secret } = process.env;
    if (!client_id || !client_secret) throw connectionError('oauth_not_configured');
    try {
        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            body: new URLSearchParams({ client_id, client_secret, refresh_token: secret, grant_type: 'refresh_token' }),
            redirect: 'error',
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw Error();
        const { access_token } = await response.json();
        if (typeof access_token !== 'string' || !access_token) throw Error();
        return access_token;
    } catch {
        throw connectionError('oauth_failed');
    }
}

async function buildClient(account, secret = decryptSecret(account.secret, account)) {
    const interfaceName = process.env.MONITOR_IMAP_INTERFACE?.trim();
    const localAddresses = interfaceName ? interfaceAddresses(interfaceName) : undefined;
    const host = await resolveImapHost(account.host, lookup, localAddresses);
    const localAddress = localAddresses?.[ipaddr.parse(host).kind() === 'ipv4' ? 4 : 6];
    const auth = account.auth_mode === 'google-oauth'
        ? { user: account.username, accessToken: await googleAccessToken(secret) }
        : { user: account.username, pass: secret };
    return new ImapFlow({
        host, servername: account.host, port: account.port,
        secure: account.secure, doSTARTTLS: !account.secure,
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', localAddress },
        auth,
        logger: false, emitLogs: false, logRaw: false,
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 120000,
        autoIdleDelay: 2000, maxIdleTime: 60000, maxResponseSize: MAX_MESSAGE_BYTES + 65536,
        qresync: false
    });
}

function trustedIds(host) {
    return [...(providers[host] || []), ...commaList(process.env.MONITOR_TRUSTED_AUTHSERV_IDS)];
}

function errorCode(error) {
    if (error?.monitorCode) return error.monitorCode;
    if (error?.authenticationFailed || error?.serverResponseCode === 'AUTHENTICATIONFAILED') return 'imap_auth_failed';
    if (error?.mailboxMissing || error?.code === 'NotFound') return 'mailbox_missing';
    if (/CERT|TLS/.test(error?.code || '')) return 'imap_tls_failed';
    if (error?.code === 'ETIMEDOUT' || error?.code === 'ETIMEOUT') return 'imap_timeout';
    if (error?.code === 'ECONNRESET') return 'imap_connection_reset';
    return 'imap_unavailable';
}

module.exports = { buildClient, validateAccount, encryptSecret, decryptSecret, encryptionKey, aad, trustedIds,
    errorCode, monitorError, isPublicAddress, resolveImapHost, interfaceAddresses };
