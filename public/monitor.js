'use strict';

const monitorPage = (() => {
    const tabs = {
        all: 'Все объявления', new: 'Новые', favorites: 'Избранные',
        assigned: 'Переданные в работу', archived: 'Архив', settings: 'Настройки мониторинга'
    };
    const categories = { apartment: 'Квартира', house: 'Дом', cottage: 'Коттедж', townhouse: 'Таунхаус',
        land: 'Земельный участок', commercial: 'Коммерческая недвижимость', garage: 'Гараж', other: 'Прочее' };
    const deals = { sale: 'Продажа', buy: 'Покупка', rent: 'Аренда' };
    const sellers = { owner: 'Собственник', agency: 'Агентство' };
    const statuses = { new: 'Новое', viewed: 'Просмотрено', assigned: 'Передано в работу', archived: 'В архиве' };
    const metrics = { today: 'Новых сегодня', week: 'Получено за неделю', total: 'Всего объявлений',
        owners: 'От собственников', lowered: 'Снижение цены', assigned: 'Передано сотрудникам', errors: 'Ошибки обработки' };
    const mailboxStatuses = { stopped: 'Остановлен', connecting: 'Подключение', active: 'Активен',
        reconnecting: 'Переподключение', error: 'Ошибка подключения' };
    const authStatuses = { verified: 'Источник подтверждён почтовым сервером', sender_unrecognized: 'Отправитель не распознан как Авито',
        untrusted_authserv: 'Результаты проверки почты отсутствуют или их сервер не распознан',
        avito_auth_failed: 'Почтовый сервер не подтвердил домен Авито' };
    const logNames = { account_created: 'Ящик добавлен', account_updated: 'Настройки ящика изменены', account_deleted: 'Ящик удалён',
        account_start: 'Мониторинг запущен', account_stop: 'Мониторинг остановлен', account_check: 'Запрошена проверка',
        connection_tested: 'Подключение проверено', invalid_size: 'Письмо превышает лимит или пустое', parse_failed: 'Ошибка разбора письма',
        no_listings: 'В письме нет распознанных объявлений', imap_auth_failed: 'IMAP отклонил данные для входа',
        imap_tls_failed: 'Ошибка TLS', imap_timeout: 'Почтовый сервер не ответил вовремя', imap_unavailable: 'IMAP недоступен',
        imap_search_failed: 'Ошибка поиска в папке', imap_fetch_failed: 'Письмо недоступно для чтения',
        imap_connection_lost: 'Потеряно соединение с IMAP',
        imap_connection_reset: 'Соединение IMAP сброшено. Проверьте исходящий доступ к почтовому серверу.',
        imap_interface_unavailable: 'Недоступен сетевой адаптер из MONITOR_IMAP_INTERFACE',
        host_blocked: 'Адрес IMAP заблокирован', credentials_unavailable: 'Проверьте ключ шифрования',
        mailbox_missing: 'Папка недоступна', dns_failed: 'Ошибка DNS', oauth_failed: 'Не удалось обновить OAuth-токен',
        oauth_not_configured: 'OAuth не настроен на сервере', invalid_mailbox: 'Почтовый сервер не вернул позицию IMAP',
        preferences_updated: 'Настройки уведомлений изменены', task_created: 'Объявление передано в работу',
        listing_favorite: 'Добавлено в избранное', listing_unfavorite: 'Удалено из избранного',
        listing_archive: 'Перемещено в архив', listing_restore: 'Восстановлено из архива', listing_delete: 'Объявление удалено',
        ...authStatuses };
    const listingFields = { external_id: 'ID объявления', title: 'Название', description: 'Описание', price: 'Цена', url: 'Ссылка',
        photo_url: 'Ссылка на фото', category: 'Категория', deal: 'Тип сделки', city: 'Город', district: 'Район', address: 'Адрес',
        area: 'Площадь', rooms: 'Комнаты', seller_type: 'Тип продавца', seller_name: 'Имя продавца', published_at: 'Опубликовано', source: 'Источник' };
    const previewProviders = { gmail: 'imap.gmail.com', yandex: 'imap.yandex.ru', mail: 'imap.mail.ru' };
    const currency = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
    const price = value => value == null || value === '' ? 'Цена не указана' : currency.format(Number(value)) + ' ₽';
    const date = value => value ? fmt(value) : '—';
    const button = (text, action, id = '', cls = '', disabled = false) =>
        `<button type="button" data-monitor-action="${action}" data-monitor-id="${E(id)}" class="${cls}" ${disabled?'disabled':''}>${text}</button>`;
    const labels = { ...categories, ...deals, ...sellers, avito: 'Авито' };
    const gallery = new Map();
    const shownPhotos = new Set();
    const route = (url, method, body) => api('/monitor' + url, method, body);
    let state, settings, tab, filters, offset, more, requestId, session, pollTimer, updateTimer, filterTimer;
    let pendingCount = 0;
    let pendingListings = false;

    function reset() {
        state = null;
        settings = null;
        tab = 'all';
        filters = {};
        offset = 0;
        more = false;
        requestId = 0;
        session = null;
        pendingCount = 0;
        pendingListings = false;
        gallery.clear();
        shownPhotos.clear();
        clearInterval(pollTimer);
        clearTimeout(updateTimer);
        clearTimeout(filterTimer);
        updateTimer = null;
    }

    function badge() {
        const count = state?.stats.unread || 0;
        return `<span class="monitor-badge" id="monitor-badge" ${count?'':'hidden'} aria-label="Новых объявлений: ${count}">${count}</span>`;
    }

    function active() {
        return isAdmin() && !!$('#monitor-page');
    }

    function signedIn() {
        reset();
        if (!isAdmin()) return;
        session = Symbol();
        void readState();
        pollTimer = setInterval(() => {
            if (active()) void sync(true);
            else void readState();
        }, 30000);
    }

    function shell() {
        return `<section id="monitor-page">
            ${heading('Мониторинг', 'Объявления из почтовых уведомлений Авито.')}
            <div id="monitor-metrics" class="monitor-metrics" aria-label="Статистика мониторинга"></div>
            <div id="monitor-tabs" class="tabs monitor-tabs" aria-label="Разделы мониторинга"></div>
            <div id="monitor-view"></div>
        </section>`;
    }

    function enter() {
        if (!active()) return;
        paintMetrics();
        paintTabs();
        switchView();
    }

    function paintMetrics() {
        const target = $('#monitor-metrics');
        if (!target) return;
        const prev = new Map([...target.querySelectorAll('[data-metric]')].map(node => [node.dataset.metric, node.textContent]));
        updateContent(target, Object.entries(metrics).map(([key, title]) =>
            `<div class="monitor-metric"><span>${title}</span><strong data-metric="${key}">${state?.stats[key] ?? '—'}</strong></div>`).join(''));
        for (const node of target.querySelectorAll('[data-metric]')) {
            if (prev.get(node.dataset.metric) !== node.textContent && state) animateIn(node);
        }
    }

    function paintTabs() {
        const target = $('#monitor-tabs');
        if (!target) return;
        updateContent(target, Object.entries(tabs).map(([key, title]) =>
            `<button type="button" data-monitor-action="tab" data-monitor-id="${key}" class="${tab===key?'active':''}"
                aria-pressed="${tab===key}">${title}</button>`).join(''));
    }

    async function readState() {
        if (!isAdmin()) return;
        const current = session;
        try {
            const response = await route('/state');
            if (current !== session) return;
            state = response;
            const count = state.stats.unread;
            const target = $('#monitor-badge');
            if (target) {
                target.hidden = count === 0;
                target.textContent = count;
                target.setAttribute('aria-label', 'Новых объявлений: ' + count);
            }
            const form = $('#monitor-preferences');
            if (form && !form.dataset.edited) {
                for (const [key, value] of Object.entries(state.preferences)) form.elements[key].checked = value;
            }
            paintMetrics();
        } catch {
            // A later Socket.IO event or periodic refresh can recover the badge.
        }
    }

    function options(choices, current) {
        return Object.entries(choices).map(([value, label]) =>
            `<option value="${E(value)}" ${current===value?'selected':''}>${E(label)}</option>`).join('');
    }

    const select = (name, title, choices, placeholder = 'Все') =>
        `<label>${title}<select name="${name}"><option value="">${placeholder}</option>${options(choices, filters[name])}</select></label>`;
    const input = (name, title, type = 'text', attrs = '') =>
        `<label>${title}<input name="${name}" type="${type}" value="${E(filters[name])}" ${attrs}></label>`;

    function dropdowns() {
        const accounts = Object.fromEntries((settings?.filterAccounts || []).map(row => [row.id, row.name]));
        const owners = Object.fromEntries(users.map(u => [u.id, u.name]));
        return select('account', 'Почтовый ящик', accounts) + select('owner', 'Ответственный', owners);
    }

    function filterForm() {
        return `<form id="monitor-filters" class="panel monitor-filters">
            <div class="monitor-search">
                ${input('q', 'Поиск по названию, адресу или описанию', 'search', 'maxlength="180"')}
                ${button('Сбросить', 'clear')}
            </div>
            <details class="monitor-extra-filters" ${Object.keys(filters).some(key=>key!=='q')?'open':''}>
                <summary>Фильтры</summary>
                <div class="monitor-filter-fields">
                    ${select('source', 'Источник', { avito: 'Авито' })}
                    <div id="monitor-dynamic-filters">${dropdowns()}</div>
                    ${input('search', 'Сохранённый поиск', 'text', 'maxlength="180"')}
                    ${input('city', 'Город', 'text', 'maxlength="180"')}
                    ${input('district', 'Район', 'text', 'maxlength="180"')}
                    ${select('category', 'Категория', { ...categories, unknown: 'Не указана' })}
                    ${select('deal', 'Тип сделки', { ...deals, unknown: 'Не определён' })}
                    ${select('seller_type', 'Тип продавца', { ...sellers, unknown: 'Не указан' })}
                    ${input('min_price', 'Цена от', 'number', 'min="0" step="0.01"')}
                    ${input('max_price', 'Цена до', 'number', 'min="0" step="0.01"')}
                    ${input('min_area', 'Площадь от, м²', 'number', 'min="0" step="0.01"')}
                    ${input('max_area', 'Площадь до, м²', 'number', 'min="0" step="0.01"')}
                    ${input('rooms', 'Комнат', 'number', 'min="0" max="999"')}
                    ${input('date', 'Дата получения', 'date')}
                    ${select('status', 'Статус', statuses)}
                </div>
            </details>
        </form>
        <div id="monitor-results" class="monitor-results" aria-live="polite"></div>
        <div id="monitor-pagination" class="line monitor-pagination"></div>`;
    }

    function switchView() {
        const target = $('#monitor-view');
        if (!target) return;
        requestId += 1;
        if (tab === 'settings') {
            target.innerHTML = settingsView();
            if (settings) paintSettings();
            void readSettings();
        } else {
            target.innerHTML = filterForm();
            void readListings(true);
            if (!settings) void readSettings();
        }
        animateIn(target);
    }

    function listingStatus(row) {
        if (row.archived) return 'archived';
        if (row.task_id) return 'assigned';
        return row.is_new ? 'new' : 'viewed';
    }

    function stage(row) {
        const status = listingStatus(row);
        return `<span class="tag ${status==='new'?'new':status==='assigned'?'done':''}">${statuses[status]}</span>`;
    }

    function external(url, title = 'Открыть на Авито') {
        // Запретить неожиданный URL даже при повреждённых данных в БД.
        if (!/^https:\/\/www\.avito\.ru\/(?:[a-z\d_%.\/-]+_\d{5,18}|items\/[a-z\d_-]{5,160})$/i.test(url || '')) return '';
        return `<a class="monitor-link" data-monitor-link href="${E(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`;
    }

    function card(row) {
        const difference = row.previous_price != null && row.price != null ? Number(row.price) - Number(row.previous_price) : null;
        const image = row.photo_url && shownPhotos.has(String(row.id))
            ? `<img src="${E(row.photo_url)}" alt="" referrerpolicy="no-referrer" loading="lazy">`
            : row.photo_url ? button('Показать фото', 'photo', row.id, 'flat') : '';
        const summary = [categories[row.category], deals[row.deal], row.area == null ? null : row.area + ' м²',
            row.rooms == null ? null : row.rooms + ' комн.', sellers[row.seller_type]].filter(Boolean).map(E).join(' · ');
        const location = [row.city, row.district, row.address].filter(Boolean).map(E).join(' · ');
        return `<article class="panel monitor-card ${row.is_new?'monitor-new':''}" data-monitor-listing="${E(row.id)}">
            ${image ? `<div class="monitor-photo">${image}</div>` : ''}
            <div class="line spread monitor-card-status">${stage(row)}<small>Авито · ${E(date(row.last_received_at))}</small></div>
            <h2>${E(row.title || 'Объявление Авито')}</h2>
            <div class="line monitor-price">
                <strong>${price(row.price)}</strong>
                ${row.area > 0 && row.price != null ? `<small>${price(Number(row.price) / Number(row.area))} / м²</small>` : ''}
                ${difference ? `<span class="tag ${difference<0?'done':'working'}">${difference<0?'−':'+'}${price(Math.abs(difference))}</span>` : ''}
            </div>
            ${summary ? `<p>${summary}</p>` : ''}
            <p class="muted">${location || 'Адрес не указан'}</p>
            ${row.task_id ? `<p class="muted">Задача №${E(row.task_id)} · ${E(row.task_deleted_at?'Удалена':row.owner_name || 'Ответственный не назначен')}</p>` : ''}
            <div class="line monitor-card-actions">
                ${button('Подробнее', 'details', row.id)}
                ${external(row.url)}
                ${!row.task_id ? button('Создать задачу', 'create-task', row.id, 'primary') : ''}
                ${button(row.favorite?'Из избранного':'В избранное', row.favorite?'unfavorite':'favorite', row.id)}
                ${button(row.archived?'Восстановить':'В архив', row.archived?'restore':'archive', row.id)}
                ${button('Удалить', 'delete', row.id, 'danger flat')}
            </div>
        </article>`;
    }

    function paintListings() {
        const target = $('#monitor-results');
        if (!target) return;
        if (!gallery.size) {
            const filtered = Object.keys(filters).length;
            updateContent(target, empty(filtered ? 'По этим фильтрам ничего не найдено' :
                tab==='archived'?'Архив пуст':tab==='favorites'?'Нет избранных объявлений':
                tab==='assigned'?'Объявления ещё не переданы в работу':'Нет объявлений. Подключите почтовый ящик в настройках мониторинга.'));
        } else updateContent(target, [...gallery.values()].map(card).join(''));
        updateContent($('#monitor-pagination'), offset || more
            ? button('Назад', 'prev', '', '', !offset) + `<span>Страница ${offset / 30 + 1}</span>` + button('Далее', 'next', '', '', !more) : '');
    }

    async function readListings(initial = false) {
        if (!active() || tab === 'settings') return;
        const current = session;
        const request = ++requestId;
        const target = $('#monitor-results');
        if (initial) {
            target.innerHTML = '<div class="monitor-skeleton" aria-label="Загрузка объявлений"></div>'.repeat(3);
            target.setAttribute('aria-busy', 'true');
        }
        try {
            const query = new URLSearchParams({ ...filters, tab, offset: String(offset) });
            const response = await route('/listings?' + query);
            if (current !== session || request !== requestId || target !== $('#monitor-results')) return;
            if (!response.listings.length && offset) {
                offset = Math.max(0, offset - 30);
                return await readListings();
            }
            gallery.clear();
            for (const row of response.listings) gallery.set(String(row.id), row);
            more = response.more;
            paintListings();
        } catch (error) {
            if (request === requestId && target === $('#monitor-results')) {
                if (initial) updateContent(target, empty(E(error.message)));
                else toast(error.message);
            }
        } finally {
            if (request === requestId) {
                target.removeAttribute('aria-busy');
            }
        }
    }

    function sourceFields(row) {
        return Object.entries(listingFields).map(([key, name]) => {
            const value = row[key];
            const label = ['category','deal','seller_type','source'].includes(key) ? labels[value] : null;
            const display = key==='price' && value!=null ? price(value) : key==='published_at' && value ? date(value) : label || value;
            return `<dt>${name}</dt><dd>${key==='url' && value ? external(value, E(value)) : E(display ?? 'Не указано')}</dd>`;
        }).join('');
    }

    async function showDetails(id) {
        const result = await route('/listings/' + id);
        if (!active()) return;
        const { listing, history, sources } = result;
        const historyList = history.map(row => `<li>${E(date(row.changed_at))} · ${price(row.old_price)} → ${price(row.new_price)}</li>`).join('');
        const sourceList = sources.map(row => `<li>${E(row.name)} · ${E(row.search_name || 'Поиск не указан')} · ${E(date(row.last_received_at))}</li>`).join('');
        openModal('monitor-listing', modalHead(E(listing.title || 'Объявление Авито')) + `
            <dl class="monitor-facts">${sourceFields(listing)}<dt>Получено</dt><dd>${E(date(listing.last_received_at))}</dd></dl>
            <h3>История цены</h3>${historyList ? `<ul>${historyList}</ul>` : '<p class="muted">Изменений пока нет</p>'}
            <h3>Почтовые уведомления</h3>${sourceList ? `<ul>${sourceList}</ul>` : '<p class="muted">Нет данных</p>'}`, true);
        if (listing.is_new) {
            await route('/listings/' + id, 'PATCH', { action: 'view' });
            void sync(true);
        }
    }

    function accountCard(row) {
        return `<article class="panel monitor-account" data-monitor-account="${E(row.id)}">
            <div class="line spread"><div><h3>${E(row.name)}</h3><p class="muted">${E(row.email)} · ${E(row.folder)}</p></div>
                <span class="tag ${row.status==='active'?'done':row.status==='error'?'failed':row.status==='connecting'||row.status==='reconnecting'?'working':''}">
                    ${mailboxStatuses[row.status] || 'Неизвестно'}
                </span>
            </div>
            <dl class="monitor-facts">
                <dt>Последняя проверка</dt><dd>${E(date(row.last_check_at))}</dd>
                <dt>Последнее письмо</dt><dd>${E(date(row.last_message_at))}</dd>
                <dt>Следующая проверка</dt><dd>${E(date(row.next_check_at))}</dd>
                <dt>Обработано писем</dt><dd>${row.processed}</dd>
            </dl>
            <div class="line">
                ${button('Редактировать', 'edit-account', row.id)}
                ${button(row.enabled?'Остановить мониторинг':'Запустить мониторинг', row.enabled?'stop-account':'start-account', row.id,
                    row.enabled?'':'primary', !row.enabled && !settings.encryptionReady)}
                ${button(row.pending_check?'Проверка запрошена':'Проверить почту сейчас', 'check-account', row.id, '', !row.enabled || row.pending_check)}
                ${button('Удалить подключение', 'delete-account', row.id, 'danger flat')}
            </div>
        </article>`;
    }

    function settingsView() {
        const defaults = state?.preferences || { toast: true, sound: false, desktop: true };
        const toggles = { toast: 'Всплывающее уведомление в CRM', sound: 'Звук', desktop: 'Системное уведомление' };
        return `<section class="monitor-accounts-section">
            <div class="line spread"><h2>Почтовые ящики</h2>${button('Добавить ящик', 'add-account', '', 'primary')}</div>
            <div id="monitor-accounts">${settings ? '' : '<div class="monitor-skeleton" aria-label="Загрузка подключений"></div>'}</div>
          </section>
          <div class="monitor-settings-grid">
            <section class="panel">
                <h2>Уведомления</h2>
                <form id="monitor-preferences" class="stack">
                    ${Object.entries(toggles).map(([key, title]) => `<label class="monitor-checkbox"><input type="checkbox" name="${key}" ${defaults[key]?'checked':''}> ${title}</label>`).join('')}
                    <div class="line"><button type="submit">Сохранить</button>${'Notification' in window && !window.evrika ? button('Разрешить в браузере', 'permissions') : ''}</div>
                </form>
            </section>
            <section class="panel">
                <h2>Проверка формата письма</h2>
                <form id="monitor-preview-form" class="stack">
                    <label>Файл .eml, до 1 МБ<input type="file" name="message" accept=".eml,message/rfc822" required></label>
                    <div><button type="submit">Предварительный просмотр</button></div>
                </form>
            </section>
          </div>
          <section class="panel monitor-logs">
            <h2>Журнал</h2><div id="monitor-logs"></div>
          </section>`;
    }

    function paintSettings() {
        if (!settings) return;
        const drop = $('#monitor-dynamic-filters');
        if (drop) updateContent(drop, dropdowns());
        const target = $('#monitor-accounts');
        if (!target) return;
        const warning = settings.encryptionReady ? '' : '<p class="monitor-warning">Задайте MONITOR_ENCRYPTION_KEY на сервере, чтобы сохранить или запустить подключение.</p>';
        updateContent(target, warning + (settings.accounts.length
            ? '<div class="monitor-accounts">' + settings.accounts.map(accountCard).join('') + '</div>'
            : empty('Подключите почтовый ящик с уведомлениями сохранённых поисков Авито.')));
        const logs = settings.logs.map(row => `<tr class="${row.level==='error'?'monitor-log-error':''}">
            <td>${E(date(row.created_at))}</td><td>${E(row.name || '—')}</td><td>${E(logNames[row.code] || row.code)}${row.uid ? ' · UID ' + E(row.uid) : ''}</td>
        </tr>`).join('');
        updateContent($('#monitor-logs'), logs ? `<div class="tablewrap"><table class="table"><thead><tr><th>Дата</th><th>Ящик</th><th>Событие</th></tr></thead>
            <tbody>${logs}</tbody></table></div>` : '<p class="muted">Событий пока нет</p>');
    }

    async function readSettings(announceErrors = false) {
        const current = session;
        try {
            const response = await route('/accounts');
            if (current !== session) return;
            settings = response;
            if (active()) paintSettings();
        } catch (error) {
            if (current === session && $('#monitor-accounts') && !settings) {
                updateContent($('#monitor-accounts'), empty(E(error.message)));
            } else if (current === session && announceErrors) toast(error.message);
        }
    }

    function editAccount(id) {
        const row = settings?.accounts.find(account => String(account.id) === id);
        const item = row || { secure: true, port: 993, poll_seconds: 60, folder: 'INBOX', auth_mode: 'password' };
        const presets = { gmail: 'Gmail', yandex: 'Яндекс Почта', mail: 'Mail.ru', manual: 'Другой провайдер' };
        const provider = Object.keys(previewProviders).find(key => previewProviders[key] === item.host) || 'manual';
        const modes = { password: 'Пароль приложения' };
        if (settings?.googleOAuth || item.auth_mode === 'google-oauth') modes['google-oauth'] = 'Gmail OAuth (refresh token)';
        const field = (name, title, type = 'text', attrs = '') =>
            `<label>${title}<input name="${name}" type="${type}" value="${E(item[name])}" ${attrs}></label>`;
        openModal('monitor-account', modalHead(row ? 'Настройки подключения' : 'Новый почтовый ящик') + `
            <form id="monitor-account-form" data-id="${E(id || '')}" class="monitor-account-form">
                <label>Провайдер<select name="provider">${options(presets, provider)}</select></label>
                ${field('name', 'Название подключения', 'text', 'required maxlength="120"')}
                ${field('email', 'Электронная почта', 'email', 'required maxlength="254"')}
                ${field('username', 'Логин IMAP', 'text', 'required maxlength="254"')}
                ${field('host', 'IMAP-сервер', 'text', 'required maxlength="253"')}
                <label>Защита соединения<select name="secure">${options({ true: 'TLS', false: 'STARTTLS' }, String(item.secure))}</select></label>
                ${field('port', 'IMAP-порт', 'number', 'required min="143" max="993"')}
                ${field('folder', 'Почтовая папка', 'text', 'required maxlength="150"')}
                ${field('poll_seconds', 'Интервал проверки, секунд', 'number', 'required min="30" max="3600"')}
                <label>Вход<select name="auth_mode">${options(modes, item.auth_mode)}</select></label>
                <label><span id="monitor-secret-label">${item.auth_mode==='google-oauth'?'Gmail refresh token':'Пароль приложения'}</span>
                    <input name="password" type="password" autocomplete="new-password" maxlength="4096" ${row?'placeholder="Оставьте пустым, чтобы сохранить текущий"':'required'}>
                </label>
                <p class="monitor-form-status" role="status" hidden></p>
                <div class="line">
                    <button class="primary" type="submit">Сохранить настройки</button>
                    <button type="submit" value="test">Проверить подключение</button>
                </div>
            </form>`, true);
    }

    async function saveAccount(form, test) {
        const values = Object.fromEntries(new FormData(form));
        const id = form.dataset.id || undefined;
        const status = form.querySelector('.monitor-form-status');
        const body = { ...values, id, secure: values.secure === 'true' };
        try {
            if (test) {
                status.textContent = 'Проверяем соединение…';
                status.hidden = false;
                await route('/accounts/test', 'POST', body);
                status.textContent = 'Подключение к папке установлено';
            } else {
                await route(id ? '/accounts/' + id : '/accounts', id ? 'PATCH' : 'POST', body);
                if (form.isConnected) modal.close();
                await readSettings(true);
                toast('Настройки подключения сохранены');
            }
        } catch (error) {
            status.hidden = false;
            status.textContent = error.message;
        }
    }

    async function showPreview(form) {
        const file = form.elements.message.files[0];
        if (!file || !file.name.toLowerCase().endsWith('.eml') || file.size > 1024 * 1024) throw Error('Выберите файл .eml размером до 1 МБ.');
        const requestToken = token;
        const response = await fetch('/api/monitor/preview', {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + requestToken }, body: file
        });
        const result = await response.json();
        if (!response.ok) {
            if (response.status === 401 && requestToken === token) logout();
            throw Error(result.error || 'Не удалось обработать письмо');
        }
        if (!active()) return;
        const reports = result.listings.map((listing, index) =>
            `<section class="panel monitor-preview-item"><h3>Объявление ${index + 1}</h3><dl class="monitor-facts">${sourceFields(listing)}</dl></section>`).join('');
        openModal('monitor-preview', modalHead('Предварительный просмотр письма') + `
            <p>${E(authStatuses[result.authentication])}</p>
            <dl class="monitor-facts"><dt>Тема</dt><dd>${E(result.subject || 'Не указано')}</dd>
                <dt>Сохранённый поиск</dt><dd>${E(result.search_name || 'Не указано')}</dd><dt>Объявлений</dt><dd>${result.listings.length}</dd></dl>
            <div class="monitor-preview-grid">${reports || empty('Ссылки на объявления в письме не распознаны')}</div>`);
    }

    function prepareTask(row) {
        if (!row || row.task_id) return toast('Для этого объявления уже создана задача');
        if (Object.values(newTaskDraft).some(Boolean) && !confirm('Заменить текущий черновик задачи данными объявления?')) return;
        const categoryMap = { house: 'house', cottage: 'house', townhouse: 'house', apartment: 'apartment', land: 'land', commercial: 'commercial', garage: 'other', other: 'other' };
        newTaskDraft = {
            direction: { sale: 'sale', buy: 'selection', rent: 'rent' }[row.deal] || '',
            deal: { sale: 'sell', buy: 'buy', rent: 'rent' }[row.deal] || '',
            property_type: categoryMap[row.category] || '',
            address: row.address || '',
            name: row.seller_name || '',
            monitor_listing_id: row.id,
            monitor_url: row.url || '',
            monitor_description: row.description || '',
            monitor_price: row.price ?? ''
        };
        employeeSearch = '';
        page = 'home';
        render();
    }

    function taskInputs(d) {
        if (!d.monitor_listing_id) return '';
        return `<section class="panel monitor-task-source">
            <div class="line spread"><h2>Данные объявления</h2>${button('Отвязать', 'unlink-task')}</div>
            <input type="hidden" name="monitor_listing_id" value="${E(d.monitor_listing_id)}">
            <label>Ссылка на Авито<input type="url" name="monitor_url" maxlength="1500" value="${E(d.monitor_url)}"></label>
            <label>Описание объявления<textarea name="monitor_description" maxlength="2000">${E(d.monitor_description)}</textarea></label>
            <label>Стоимость, ₽<input name="monitor_price" type="number" min="0" step="0.01" value="${E(d.monitor_price)}"></label>
        </section>`;
    }

    function taskDetails(task) {
        return (task.monitor_url ? external(task.monitor_url) : '') +
            (task.monitor_price != null ? field('Цена объявления', price(task.monitor_price)) : '') +
            (task.monitor_description ? field('Описание объявления', task.monitor_description) : '');
    }

    function sync(listings = false) {
        const work = [readState()];
        if (active()) {
            if (tab==='settings' || !settings) work.push(readSettings());
            if (listings && tab!=='settings') work.push(readListings());
        }
        return Promise.all(work);
    }

    function notify(count) {
        if (!count || !state) return;
        const { preferences } = state;
        const message = 'Новых объявлений: ' + count;
        if (preferences.toast) toast(message);
        if (preferences.sound) new Audio('/assets/new-task.wav').play().catch(() => {});
        if (preferences.desktop) {
            if (window.evrika?.notifyMonitor) window.evrika.notifyMonitor(count).catch(() => {});
            else if ('Notification' in window && Notification.permission === 'granted') {
                new Notification('EVRIKA Monitor', { body: message, silent: true });
            }
        }
    }

    function onUpdate(event) {
        if (!isAdmin()) return;
        pendingCount += Number(event.count || 0);
        pendingListings ||= !!event.listings;
        if (updateTimer) return;
        updateTimer = setTimeout(async () => {
            const count = pendingCount;
            const listings = pendingListings;
            pendingCount = 0;
            pendingListings = false;
            updateTimer = null;
            const current = session;
            await sync(listings);
            if (current === session) notify(count);
        }, 350);
    }

    function changedFilters(form) {
        filters = Object.fromEntries([...new FormData(form)].filter(([, value]) => String(value).trim()));
        offset = 0;
        clearTimeout(filterTimer);
        filterTimer = setTimeout(readListings, 180);
    }

    document.addEventListener('input', event => {
        if (event.target.closest('#monitor-filters')) changedFilters(event.target.form);
        if (event.target.form?.id === 'monitor-preferences') event.target.form.dataset.edited = 'true';
    });

    document.addEventListener('change', event => {
        const control = event.target;
        if (control.closest('#monitor-filters')) changedFilters(control.form);
        if (control.form?.id !== 'monitor-account-form') return;
        const { elements } = control.form;
        if (control.name === 'provider') {
            elements.host.value = previewProviders[control.value] || '';
            elements.port.value = 993;
            elements.secure.value = 'true';
            elements.auth_mode.value = 'password';
        }
        if (control.name === 'email' && !elements.username.value) elements.username.value = control.value;
        if (control.name === 'secure') elements.port.value = control.value === 'true' ? 993 : 143;
        $('#monitor-secret-label').textContent = elements.auth_mode.value === 'google-oauth' ? 'Gmail refresh token' : 'Пароль приложения';
    });

    document.addEventListener('submit', async event => {
        const form = event.target;
        if (!form.id.startsWith('monitor-') || !isAdmin()) return;
        event.preventDefault();
        const submit = event.submitter;
        if (submit?.disabled) return;
        const controls = [...form.querySelectorAll('button[type=submit]')];
        for (const control of controls) control.disabled = true;
        try {
            if (form.id === 'monitor-account-form') await saveAccount(form, submit?.value === 'test');
            if (form.id === 'monitor-preview-form') await showPreview(form);
            if (form.id === 'monitor-filters') changedFilters(form);
            if (form.id === 'monitor-preferences') {
                const data = Object.fromEntries(['toast','sound','desktop'].map(key => [key, form.elements[key].checked]));
                if (state) state.preferences = await route('/preferences', 'PUT', data);
                else await route('/preferences', 'PUT', data);
                toast('Настройки уведомлений сохранены');
            }
        } catch (error) {
            toast(error.message);
        } finally {
            for (const control of controls) control.disabled = false;
        }
    });

    document.addEventListener('click', async event => {
        const link = event.target.closest('[data-monitor-link]');
        if (link && window.evrika?.openListing) {
            event.preventDefault();
            try { await window.evrika.openListing(link.href); }
            catch { toast('Не удалось открыть ссылку'); }
            return;
        }
        const control = event.target.closest('[data-monitor-action]');
        if (!control || !isAdmin()) return;
        const { monitorAction: action, monitorId: id } = control.dataset;
        control.disabled = true;
        try {
            switch (action) {
            case 'tab':
                if (id !== tab) {
                    tab = id;
                    offset = 0;
                    clearTimeout(filterTimer);
                    paintTabs();
                    switchView();
                }
                break;
            case 'clear': filters = {}; offset = 0; switchView(); break;
            case 'prev': offset = Math.max(0, offset - 30); await readListings(true); break;
            case 'next': offset += 30; await readListings(true); break;
            case 'photo': shownPhotos.add(id); paintListings(); break;
            case 'details': await showDetails(id); break;
            case 'create-task': prepareTask(gallery.get(id)); break;
            case 'unlink-task': for (const key of Object.keys(newTaskDraft)) {
                if (key.startsWith('monitor_')) delete newTaskDraft[key];
            } render(); break;
            case 'add-account': case 'edit-account': editAccount(id); break;
            case 'permissions': await Notification.requestPermission(); break;
            case 'start-account': case 'stop-account': case 'check-account':
                await route('/accounts/' + id + '/' + action.split('-')[0], 'POST');
                await readSettings(true);
                break;
            case 'delete-account':
                if (confirm('Удалить подключение? Полученные объявления останутся в CRM.')) {
                    await route('/accounts/' + id, 'DELETE');
                    await readSettings(true);
                }
                break;
            case 'delete':
                if (!confirm('Удалить объявление из мониторинга?')) break;
                // falls through
            case 'favorite': case 'unfavorite': case 'archive': case 'restore':
                await route('/listings/' + id, 'PATCH', { action });
                await sync(true);
                break;
            }
        } catch (error) {
            toast(error.message);
        } finally {
            if (!['start-account','stop-account','check-account'].includes(action)) control.disabled = false;
            else if (control.isConnected && !settings?.accounts.find(account => String(account.id)===id)?.pending_check) control.disabled = false;
        }
    });

    reset();
    return { badge, shell, enter, reset, signedIn, onUpdate, sync, taskInputs, taskDetails };
})();
