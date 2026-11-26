'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseMessage, listingLink, photoLink, MAX_MESSAGE_BYTES } = require('../server/monitor/parser');
const { validateAccount, encryptSecret, decryptSecret, isPublicAddress, resolveImapHost, errorCode, interfaceAddresses } = require('../server/monitor/connection');
const { listingQuery, validDate } = require('../server/monitor/store');
const { retryDelay } = require('../server/monitor/service');
const { parseTaskOptions } = require('../server/monitor/routes');

const fixture = name => readFileSync(join(__dirname, 'fixtures', 'monitor', name));
const trusted = ['mx.google.com'];

test('plain Avito mail extracts multiple listings and preserves missing fields', async () => {
    const result = await parseMessage(fixture('text.eml'), trusted);
    assert.equal(result.authentication, 'verified');
    assert.equal(result.search_name, 'Дома и участки');
    assert.equal(result.listings.length, 2);
    const [house, land] = result.listings;
    assert.equal(house.external_id, '123456789');
    assert.equal(house.url, 'https://www.avito.ru/nazran/doma_dom_123456789');
    assert.equal(house.price, 6450000);
    assert.equal(house.rooms, 4);
    assert.equal(house.area, 95);
    assert.equal(house.seller_type, 'owner');
    assert.equal(house.seller_name, 'Анна');
    assert.equal(house.deal, 'sale');
    assert.equal(house.published_at, '2026-11-08T00:00:00.000Z');
    assert.equal(land.category, 'land');
    assert.equal(land.deal, 'buy');
    assert.equal(land.price, null);
    assert.equal(land.address, null);
});

test('HTML cards keep fields isolated and ignore unsafe links and pixels', async () => {
    const result = await parseMessage(fixture('html.eml'), trusted);
    assert.equal(result.authentication, 'verified');
    assert.equal(result.search_name, 'Квартиры города');
    assert.equal(result.listings.length, 2);
    const [apartment, garage] = result.listings;
    assert.equal(apartment.title, '2-комнатная квартира, 54,5 м²');
    assert.equal(apartment.area, 54.5);
    assert.equal(apartment.rooms, 2);
    assert.equal(apartment.deal, 'rent');
    assert.equal(apartment.price, 5750000);
    assert.equal(apartment.photo_url, 'https://static.avito.st/items/real-photo.jpg');
    assert.equal(garage.price, 1300000);
    assert.equal(garage.photo_url, null);
    assert.equal(garage.address, null);
    assert.equal(garage.category, 'garage');
    assert.equal(garage.deal, null);
});

test('parser distinguishes trusted verification from preview-only mail', async () => {
    const mail = fixture('text.eml').toString();
    const forged = mail.replace('alerts@avito.ru', 'alerts@avito.ru.example');
    const earlierResult = mail.replace('Authentication-Results:', 'Authentication-Results: untrusted.example; none\nAuthentication-Results:');
    const failed = mail.replace('dmarc=pass', 'dmarc=fail');
    assert.equal((await parseMessage(Buffer.from(forged), trusted)).authentication, 'sender_unrecognized');
    assert.equal((await parseMessage(Buffer.from(earlierResult), trusted)).authentication, 'untrusted_authserv');
    assert.equal((await parseMessage(Buffer.from(failed), trusted)).authentication, 'avito_auth_failed');
    assert.equal((await parseMessage(fixture('text.eml'))).listings.length, 2);
    await assert.rejects(parseMessage(Buffer.alloc(MAX_MESSAGE_BYTES + 1), trusted), { code: 'invalid_size' });
});

test('direct listing URLs and optional images are normalized and constrained', () => {
    assert.deepEqual(listingLink('https://m.avito.ru/items/example_slug?track=secret'), {
        external_id: null, url: 'https://www.avito.ru/items/example_slug'
    });
    assert.equal(listingLink('https://avito.ru@evil.example/sale_123456'), null);
    assert.equal(listingLink('https://www.avito.ru:444/sale_123456'), null);
    assert.equal(listingLink('https://www.avito.ru/redirect?url=https://evil.example/fake_123456'), null);
    assert.equal(listingLink('javascript:alert(1)'), null);
    assert.equal(photoLink('https://cdn.avito.st/items/test.jpg?mail=secret'), 'https://cdn.avito.st/items/test.jpg');
    assert.equal(photoLink('https://cdn.avito.st/track/px.gif'), null);
});

test('mail credentials are authenticated, randomized and bound to connection identity', () => {
    const account = validateAccount({ name: 'Test', email: 'USER@example.com', host: 'imap.gmail.com',
        username: 'user@example.com', port: 993, secure: true, folder: 'inbox' });
    const key = randomBytes(32);
    const secret = 'fixture-app-password';
    const cipher = encryptSecret(secret, account, key);
    assert.equal(account.email, 'user@example.com');
    assert.equal(account.folder, 'INBOX');
    assert.equal(account.poll_seconds, 60);
    assert.notEqual(encryptSecret(secret, account, key), cipher);
    assert.equal(decryptSecret(cipher, account, key), secret);
    assert.throws(() => decryptSecret(cipher, { ...account, username: 'other@example.com' }, key), /credentials_unavailable/);
    assert.throws(() => decryptSecret(cipher, account, randomBytes(32)), /credentials_unavailable/);
    assert.throws(() => validateAccount({ ...account, port: 143 }), { status: 400 });
});

test('IMAP DNS targets are pinned to public addresses and mixed answers are refused', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.2', '::1', '::ffff:127.0.0.1', 'fc00::1']) {
        assert.equal(isPublicAddress(address), false, address);
    }
    assert.equal(isPublicAddress('8.8.8.8'), true);
    const safe = { family: 4, address: '8.8.8.8' };
    assert.equal(await resolveImapHost('imap.gmail.com', async () => [safe]), '8.8.8.8');
    await assert.rejects(resolveImapHost('imap.gmail.com', async () => [safe, { family: 6, address: '::1' }]), /host_blocked/);
    await assert.rejects(resolveImapHost('127.0.0.1', async () => [safe]), /host_blocked/);
});

test('listing filters bind user input and task options validate the original link', () => {
    const input = "x' OR 1=1 --";
    const query = listingQuery({ q: input, owner: '12', category: 'house', date: '2026-11-26' });
    assert.equal(query.where.includes(input), false);
    assert.deepEqual(query.values, [input, 'house', '12', '2026-11-26']);
    assert.equal(validDate('2026-02-31'), false);
    assert.throws(() => listingQuery({ min_price: 'NaN' }), { status: 400 });
    assert.equal(parseTaskOptions({}), null);
    assert.throws(() => parseTaskOptions({ monitor_listing_id: '2', monitor_url: 'https://other.example/item' }), { status: 400 });
});

test('worker reconnection delay grows and stops at five minutes', () => {
    assert.deepEqual([1,2,3,4,9].map(retryDelay), [5000,10000,20000,40000,300000]);
});

test('IMAP distinguishes a connection reset from rejected credentials', () => {
    assert.equal(errorCode({ code: 'ECONNRESET' }), 'imap_connection_reset');
    assert.equal(errorCode({ serverResponseCode: 'AUTHENTICATIONFAILED' }), 'imap_auth_failed');
});

test('IMAP pinning selects public destinations reachable from the configured interface', async () => {
    const interfaces = {
        Ethernet: [{ address: '192.168.0.2' }, { address: 'fe80::2' }],
        VPN: [{ address: '172.19.0.1' }]
    };
    const local = interfaceAddresses('Ethernet', interfaces);
    assert.deepEqual(local, { 4: '192.168.0.2' });
    const ipv6 = { address: '2606:4700:4700::1111', family: 6 };
    const ipv4 = { address: '1.1.1.1', family: 4 };
    assert.equal(await resolveImapHost('imap.mail.ru', async () => [ipv6, ipv4], local), ipv4.address);
    await assert.rejects(resolveImapHost('imap.mail.ru', async () => [ipv6], local), /imap_interface_unavailable/);
    assert.throws(() => interfaceAddresses('Missing', interfaces), /imap_interface_unavailable/);
});
