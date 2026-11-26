'use strict';

const { createServer } = require('node:net');
const { once } = require('node:events');

async function createImapFixture() {
    const messages = new Map();
    const peers = new Set();
    const commands = [];
    const server = createServer(peer => {
        peers.add(peer);
        let buffer = '';
        let idleTag;
        const send = text => peer.write(text + '\r\n');
        send('* OK [CAPABILITY IMAP4rev1 IDLE] EVRIKA test mailbox');
        peer.on('close', () => peers.delete(peer));
        peer.on('error', () => {});
        peer.on('data', chunk => {
            buffer += chunk.toString('utf8');
            let newline;
            while ((newline = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 2);
                if (line === 'DONE' && idleTag) {
                    send(idleTag + ' OK IDLE completed');
                    idleTag = null;
                    continue;
                }
                const [tag, command, ...args] = line.split(' ');
                commands.push(command === 'UID' ? args[0] + ' ' + args.slice(1).join(' ') : command);
                const ok = () => send(tag + ' OK completed');
                const next = Math.max(0, ...messages.keys()) + 1;
                if (command === 'CAPABILITY') send('* CAPABILITY IMAP4rev1 IDLE');
                if (command === 'LIST') send('* LIST (\\HasNoChildren) "/" "INBOX"');
                if (command === 'EXAMINE') {
                    send('* FLAGS (\\Seen)');
                    send('* ' + messages.size + ' EXISTS');
                    send('* OK [UIDVALIDITY 999] UIDs valid');
                    send('* OK [UIDNEXT ' + next + '] Next UID');
                    send(tag + ' OK [READ-ONLY] selected INBOX');
                    continue;
                }
                if (command === 'STATUS') send('* STATUS INBOX (UIDNEXT ' + next + ' UIDVALIDITY 999 MESSAGES ' + messages.size + ')');
                if (command === 'UID' && args[0] === 'SEARCH') {
                    send('* SEARCH' + [...messages.keys()].map(uid => ' ' + uid).join(''));
                }
                if (command === 'UID' && args[0] === 'FETCH') {
                    const uid = Number(args[1]);
                    const item = messages.get(uid);
                    if (item) {
                        const index = [...messages.keys()].indexOf(uid) + 1;
                        const prefix = '* ' + index + ' FETCH (UID ' + uid + ' ';
                        if (args.join(' ').includes('BODY.PEEK')) {
                            send(prefix + 'BODY[]<0> {' + item.source.length + '}');
                            peer.write(item.source);
                            send(')');
                        } else {
                            const [, day, month, year, time] = item.received.toUTCString().match(/^\w+, (\d+) (\w+) (\d+) (.+) GMT$/);
                            send(prefix + 'RFC822.SIZE ' + item.source.length + ' INTERNALDATE "' + day + '-' + month + '-' + year + ' ' + time + ' +0000")');
                        }
                    }
                }
                if (command === 'IDLE') {
                    idleTag = tag;
                    send('+ Idling');
                    continue;
                }
                if (command === 'LOGOUT') {
                    send('* BYE Logout');
                    ok();
                    peer.end();
                    continue;
                }
                ok();
            }
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
        port: server.address().port,
        commands,
        append(source, received = new Date()) {
            const uid = messages.size + 1;
            const wire = Buffer.from(source.toString('utf8').replace(/\r?\n/g, '\r\n'));
            messages.set(uid, { source: wire, received });
            for (const peer of peers) peer.write('* ' + messages.size + ' EXISTS\r\n');
            return uid;
        },
        async close() {
            for (const peer of peers) peer.destroy();
            await new Promise(resolve => server.close(resolve));
        }
    };
}

module.exports = { createImapFixture };
