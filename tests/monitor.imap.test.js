'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { ImapFlow } = require('imapflow');
const { createImapFixture } = require('./fixtures/monitor/imap');
const { parseMessage } = require('../server/monitor/parser');

test('ImapFlow reads an IMAP mailbox with EXAMINE, BODY.PEEK and IDLE', { timeout: 8000 }, async () => {
    const fixture = await createImapFixture();
    const client = new ImapFlow({
        host: '127.0.0.1', port: fixture.port, secure: false, doSTARTTLS: false,
        auth: { user: 'fixture', pass: 'fixture-only' }, logger: false, disableCompression: true, autoIdleDelay: 30
    });
    client.on('error', () => {});
    try {
        await client.connect();
        await client.mailboxOpen('INBOX', { readOnly: true });
        for (let i = 0; i < 100 && !fixture.commands.includes('IDLE'); i += 1) await delay(10);
        assert.equal(fixture.commands.includes('IDLE'), true);
        const message = readFile(join(__dirname, 'fixtures', 'monitor', 'text.eml'));
        const arrival = once(client, 'exists', { signal: AbortSignal.timeout(2000) });
        const uid = fixture.append(await message);
        const [event] = await arrival;
        assert.equal(event.count, 1);
        const status = await client.status('INBOX', { uidNext: true, uidValidity: true });
        assert.equal(status.uidNext, uid + 1);
        const [result] = await client.search({ uid: '1:' + uid, from: 'avito.ru' }, { uid: true });
        assert.equal(result, uid);
        const data = await client.fetchOne(String(uid), { source: { start: 0, maxLength: 1024 * 1024 } }, { uid: true });
        assert.equal((await parseMessage(data.source, ['mx.google.com'])).listings.length, 2);
        assert.ok(fixture.commands.includes('EXAMINE'));
        assert.ok(fixture.commands.some(command => command.includes('BODY.PEEK')));
        assert.ok(!fixture.commands.some(command => /STORE|EXPUNGE/.test(command)));
        await client.logout();
    } finally {
        client.close();
        await fixture.close();
    }
});
