'use strict';

const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_LISTINGS = 100;
const listingHosts = new Set(['avito.ru', 'www.avito.ru', 'm.avito.ru']);
const senderDomain = /^(?:[a-z0-9-]+\.)*avito\.ru$/i;
const dealNames = [
    ['sale', /продаж|продам|прода[её]тся/i],
    ['buy', /покупк|куплю/i],
    ['rent', /аренд|сдам|сниму/i]
];
const categories = [
    ['townhouse', /таунхаус/i],
    ['cottage', /коттедж/i],
    ['apartment', /квартир|студи[яи]/i],
    ['land', /участ(?:ок|ка|ки)|земельн/i],
    ['commercial', /коммерческ|офис\p{L}*|склад\p{L}*/iu],
    ['garage', /гараж|машино.?мест/i],
    ['house', /(?:^|[^\p{L}])дом(?:а|ов)?(?:$|[^\p{L}])/iu],
    ['other', /^прочее$|^другое$/i]
];
const normalize = (value, limit = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit) || null;
const stripURLTail = value => value.replace(/[.,;!:)>\]]+$/, '');

function listingLink(value) {
    try {
        const url = new URL(stripURLTail(String(value)));
        if (url.protocol !== 'https:' || url.port || url.username || url.password || !listingHosts.has(url.hostname)) return null;
        const match = url.pathname.match(/_(\d{5,18})\/?$/);
        const item = url.pathname.match(/^\/items\/([a-z\d_-]{5,160})\/?$/i);
        if (!match && !item) return null;
        if (!/^\/(?:[a-z\d_%.-]+\/)*[a-z\d_%.-]+\/?$/i.test(url.pathname)) return null;
        return {
            external_id: match?.[1] || (/^\d{5,18}$/.test(item?.[1]) ? item[1] : null),
            url: 'https://www.avito.ru' + url.pathname.replace(/\/$/, '')
        };
    } catch {
        return null;
    }
}

function photoLink(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
        if (!/^(?:[a-z0-9-]+\.)*avito\.st$/i.test(url.hostname)) return null;
        if (!/^\/(?:items|image|images|item)\//i.test(url.pathname)) return null;
        url.search = '';
        url.hash = '';
        return url.href.length <= 1500 ? url.href : null;
    } catch {
        return null;
    }
}

function isAvitoSender(mail) {
    return mail.from?.value?.length === 1 && senderDomain.test(mail.from.value[0].address?.split('@').at(-1));
}

function authenticate(mail, trustedIds = []) {
    if (!isAvitoSender(mail)) return 'sender_unrecognized';
    const first = mail.headerLines.find(header => header.key === 'authentication-results');
    const result = first?.line.replace(/^[^:]+:/, '').replace(/\r?\n[ \t]+/g, ' ').trim() || '';
    const parts = result.split(';');
    const [authserv] = parts.shift().trim().split(/\s+/);
    if (!trustedIds.includes(authserv.toLowerCase())) return 'untrusted_authserv';
    for (const part of parts) {
        const clean = part.replace(/\([^()]*\)/g, '').trim();
        const match = clean.match(/^(dmarc|dkim)=pass(?=\s|$)/i);
        if (!match) continue;
        const attribute = match[1].toLowerCase() === 'dmarc' ? 'from' : '[di]';
        const domain = clean.match(new RegExp('\\bheader\\.' + attribute + '="?@?([a-z0-9.-]+)"?(?=\\s|$)', 'i'));
        if (domain && senderDomain.test(domain[1])) return 'verified';
    }
    return 'avito_auth_failed';
}

function field(lines, keys, limit = 500) {
    for (const line of lines) {
        const separator = line.match(/^([^:]{1,40}):\s*(.+)$/);
        if (separator && keys.includes(separator[1].trim().toLowerCase())) return normalize(separator[2], limit);
    }
    return null;
}

function number(value, max = 99999999999999) {
    if (!value) return null;
    const cleaned = value.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
    if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
    const amount = Number(cleaned);
    return Number.isFinite(amount) && amount <= max ? amount : null;
}

function published(value) {
    if (!value) return null;
    const date = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    const iso = date ? [date[3], date[2], date[1]].join('-') : value;
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(iso)) return null;
    const base = new Date(iso.slice(0, 10));
    const parsed = new Date(iso);
    return !Number.isNaN(+base) && base.toISOString().slice(0, 10) === iso.slice(0, 10) && !Number.isNaN(+parsed)
        ? parsed.toISOString() : null;
}

function usableTitle(value) {
    const title = normalize(value, 220);
    if (!title || /^(?:https?:|цена:|площадь:|адрес:|подробнее\b|подробнее$|смотреть|открыть|на авито|авито$|[\d\s]+(?:₽|руб))/i.test(title)) return null;
    return title;
}

function collectFields(text, titleHint, photo) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const value = (...keys) => field(lines, keys);
    const title = usableTitle(value('название', 'заголовок')) || usableTitle(titleHint) ||
        lines.map(line => !line.includes(':') && usableTitle(line)).find(Boolean) || null;
    const numericToken = '([0-9][0-9 \\u00a0\\u202f]*?(?:[,.][0-9]{1,2})?)';
    const priceText = value('цена', 'стоимость') || lines.find(line => /₽|руб\./i.test(line));
    const priceMatch = priceText?.match(new RegExp(numericToken + '\\s*(?:₽|руб(?:лей|\\.)?|RUB)(?![\\p{L}])', 'iu'));
    const unitlessPrice = value('цена', 'стоимость');
    const areaText = value('площадь', 'общая площадь') || title || '';
    const area = number(areaText.match(new RegExp(numericToken + '\\s*(?:м²|м2|кв\\.?\\s*м)(?![\\p{L}])', 'iu'))?.[1] || value('площадь', 'общая площадь'), 9999999999);
    const roomsText = value('комнат', 'количество комнат', 'комнаты') || title;
    const rooms = roomsText?.match(/^\s*(\d{1,3})(?:$|[- ]?(?:комн|к\.))/i);
    const seller = value('продавец');
    const sellerType = value('тип продавца') || seller || lines.find(line => /^(?:собственник|агентство|агент)$/i.test(line));
    const category = value('категория', 'тип недвижимости', 'тип объекта') || title || '';
    const deal = value('тип сделки', 'сделка') || title || '';
    return {
        title, photo_url: photo || photoLink(value('фото', 'фотография')),
        description: field(lines, ['описание'], 2000),
        price: number(priceMatch?.[1] || unitlessPrice),
        category: categories.find(([, pattern]) => pattern.test(category))?.[0] || null,
        deal: dealNames.find(([, pattern]) => pattern.test(deal))?.[0] || null,
        city: value('город', 'населённый пункт', 'населенный пункт'),
        district: value('район'), address: value('адрес', 'адрес объекта'),
        area: area > 0 ? area : null, rooms: rooms ? Number(rooms[1]) : null,
        seller_type: /собственник/i.test(sellerType) ? 'owner' : /агент/i.test(sellerType) ? 'agency' : null,
        seller_name: value('имя продавца', 'контактное лицо') || (seller && !/собственник|агент/i.test(seller) ? seller : null),
        published_at: published(value('опубликовано', 'дата публикации'))
    };
}

function parseHtml(html) {
    if (!html) return { listings: [], searchName: null };
    const $ = cheerio.load(html);
    $('script, style, iframe, object, embed, svg, template, head, noscript').remove();
    $('br').replaceWith('\n');
    $('div, p, h1, h2, h3, h4, tr, li, td').each((_, node) => $(node).append('\n'));
    const links = new Map();
    for (const node of $('a[href]').toArray()) {
        const link = listingLink($(node).attr('href'));
        if (link) links.set(node, link);
    }
    const results = [];
    for (const [node, link] of links) {
        const anchor = $(node);
        let block = anchor;
        for (let parent = anchor.parent(), depth = 0; parent.length && depth < 6; parent = parent.parent(), depth += 1) {
            if (parent.is('body, html') || parent.text().length > 3500) break;
            const hasOtherListing = parent.find('a[href]').toArray().some(other => {
                const otherLink = links.get(other);
                return otherLink && (otherLink.external_id || otherLink.url) !== (link.external_id || link.url);
            });
            if (hasOtherListing) break;
            block = parent;
        }
        const image = block.find('img').toArray().find(img => {
            const { width, height, src } = $(img).attr();
            return Number(width) !== 1 && Number(height) !== 1 && photoLink(src);
        });
        const fields = collectFields(block.text(), usableTitle(anchor.text()) || block.find('h1,h2,h3,h4').first().text(), image && photoLink($(image).attr('src')));
        results.push({ ...link, ...fields });
        if (results.length >= MAX_LISTINGS) break;
    }
    return { listings: results, searchName: field($('body').text().split(/\r?\n/), ['поиск', 'сохранённый поиск', 'сохраненный поиск'], 180) };
}

function parseText(text) {
    if (!text) return [];
    const matches = [...text.matchAll(/https:\/\/[^\s<>"']+/gi)]
        .map(match => ({ ...listingLink(match[0]), start: match.index, end: match.index + match[0].length }))
        .filter(match => match.url).slice(0, MAX_LISTINGS);
    return matches.map(({ start, end, ...link }, index) => {
        const before = text.slice(matches[index - 1]?.end || 0, start).slice(-2500);
        const priorParagraph = before.trim().split(/\r?\n\s*\r?\n/).at(-1) || '';
        const after = text.slice(end, matches[index + 1]?.start || text.length);
        const followingLines = after.split(/\r?\n\s*\r?\n/, 1)[0].slice(0, 1200);
        const fields = collectFields(priorParagraph + '\n' + followingLines);
        return { ...link, ...fields };
    });
}

async function parseMessage(source, trustedIds = []) {
    if (!Buffer.isBuffer(source) || !source.length || source.length > MAX_MESSAGE_BYTES) {
        throw Object.assign(Error('invalid_size'), { code: 'invalid_size' });
    }
    const mail = await simpleParser(source, { skipImageLinks: true, skipTextLinks: true, skipHtmlToText: true });
    const authentication = authenticate(mail, trustedIds);
    const subject = normalize(mail.subject);
    const html = parseHtml(mail.html);
    const search_name = field((mail.text || '').split(/\r?\n/), ['поиск', 'сохранённый поиск', 'сохраненный поиск'], 180) || html.searchName ||
        normalize(subject?.match(/(?:по запросу|сохран[её]нный поиск)\s*[:«"]\s*([^»"]+)/i)?.[1], 180);
    const listings = new Map();
    for (const listing of [...html.listings, ...parseText(mail.text)]) {
        const key = listing.external_id || listing.url;
        const prior = listings.get(key);
        if (!prior && listings.size >= MAX_LISTINGS) continue;
        if (!prior) listings.set(key, listing);
        else for (const [name, value] of Object.entries(listing)) prior[name] ??= value;
    }
    return { authentication, subject, search_name, messageId: normalize(mail.messageId), listings: [...listings.values()].map(listing => ({ source: 'avito', ...listing })) };
}

module.exports = { parseMessage, listingLink, photoLink, MAX_MESSAGE_BYTES };
