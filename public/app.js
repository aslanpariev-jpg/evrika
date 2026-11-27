'use strict';
const $=s=>document.querySelector(s), nav=$('#nav'), modal=$('#modal'), mc=$('#modal-content');
let main=$('#main');
let taskClockSnapshot = performance.now();
const E=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={rent:'Аренда',admin_credentials:'Изменены данные администратора',selection:'Подбор объекта',sale:'Продать объект',buy:'Купить',sell:'Продать',none:'Не выбрано',success:'Сделка состоялась',failed:'Сделка сорвалась',postponed:'Сделка перенеслась',login:'Вход',employee_create:'Добавлен сотрудник',employee_edit:'Изменён сотрудник',employee_delete:'Удалён сотрудник',task_create:'Создана задача',task_claim:'Задача принята',task_assign:'Задача назначена',task_revoke:'Задача отозвана',comment_working:'Комментарий в работе',comment_done:'Комментарий о проделанном',task_result:'Результат сделки',task_delete:'Удалена задача',export:'Экспорт Excel'};
const themes={gold:'Black & Gold',dark:'Dark',light:'Light',midnight:'Midnight',graphite:'Graphite',emerald:'Emerald',purple:'Purple'};
const propertyTypes={house:'Дом',apartment:'Квартира',land:'Участок',commercial:'Коммерческая недвижимость',other:'Другое'};
let token=sessionStorage.getItem('evrika-token')||'', user=null,tasks=[],users=[],socket=null,page='',filter='active',query='',selectedEmployee=null,toastTimer,refreshTimer,refreshPromise=null,dirty=false,modalKind='',sessionGeneration=0;const drafts=new Map();let newTaskDraft={},employeeSearch='',clientSearch='';const isAdmin=()=>user?.role==='admin',closed=t=>['success','failed'].includes(t.result),owner=t=>String(t.owner_id)===String(user?.id),editable=t=>isAdmin()||owner(t)&&!closed(t);const fmt=v=>v?new Date(v).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'}):'—';const dateOnly=v=>v?String(v).slice(0,10):'';const button=(txt,act,tid='',cls='')=>`<button class="${cls}" data-act="${act}" data-id="${E(tid)}">${txt}</button>`;
function theme(){const next=localStorage.getItem('evrika-theme-'+(user?.login||'guest'))||'gold';document.body.dataset.theme=next;}theme();
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('visible'),4500);}
async function api(url,method='GET',body){const requestToken=token;const r=await fetch('/api'+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});if(!r.ok){const j=await r.json().catch(()=>({}));if(r.status===401&&url!='/login'&&requestToken===token)logout(false);throw Error(j.error||'Ошибка '+r.status);}return r.json();}
function logout(renderLogin=true){monitorPage.reset();document.querySelectorAll('.task-ghost').forEach(el=>el.remove());sessionGeneration++;if(socket){socket.disconnect();socket=null;}token='';user=null;tasks=[];users=[];drafts.clear();newTaskDraft={};employeeSearch='';clientSearch='';query='';filter='active';selectedEmployee=null;sessionStorage.removeItem('evrika-token');if(modal.open)modal.close();theme();loginScreen();}
function loginScreen() {
    nav.innerHTML = '';
    $('#who').textContent = '';
    $('#logout').hidden = true;
    const desktopCredentials = window.evrika?.readCredentials && window.evrika?.writeCredentials;
    main.innerHTML = `
        <form class="panel login" id="loginForm">
            <img src="/assets/logo.webp" alt="EVRIKA">
            <label for="login-name">Логин</label>
            <input id="login-name" name="login" autocomplete="username" required autofocus>
            <label for="login-password">Пароль</label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" required>
            <button class="primary">Войти</button>
            ${desktopCredentials ? '<label class="remember-login"><input type="checkbox" name="remember"> Запомнить меня</label>' : ''}
        </form>`;
    if (!desktopCredentials) return;
    const form = $('#loginForm');
    const { login, password, remember } = form.elements;
    let edited = false;
    form.addEventListener('input', () => { edited = true; }, { once: true });
    window.evrika.readCredentials().then(saved => {
        if (!saved || edited || !form.isConnected || login.value || password.value) return;
        login.value = saved.login;
        password.value = saved.password;
        remember.checked = true;
    }).catch(() => {});
}

async function signIn({ login, password, remember }) {
    const result = await api('/login', 'POST', { login, password });
    token = result.token;
    sessionStorage.setItem('evrika-token', token);
    const generation = sessionGeneration;
    await start(result.user);
    if (!window.evrika?.writeCredentials || generation !== sessionGeneration) return;
    const saved = remember ? { login: login.trim().slice(0, 100), password: password.slice(0, 200) } : null;
    try {
        await window.evrika.writeCredentials(saved);
    } catch {
        toast(remember ? 'Не удалось запомнить данные для входа' : 'Не удалось удалить сохранённые данные для входа');
    }
}
async function start(u){const expected=window.evrika?.role||new URLSearchParams(location.search).get('role');if(expected&&expected!==u.role){logout();throw Error('Используйте приложение для вашей роли');}user=u;page=isAdmin()?'home':'mine';monitorPage.signedIn();theme();$('#who').textContent=user.name;$('#logout').hidden=false;render();await refresh();connect();}
function notify(){toast('Получена новая задача');try{const a=new Audio('/assets/new-task.wav');a.play().catch(()=>{});}catch{}if(window.evrika)window.evrika.notify();else if('Notification'in window&&Notification.permission==='granted')new Notification('EVRIKA CRM',{body:'Получена новая задача'});}
function connect() {
    socket?.disconnect();
    const current = io({ auth: { token }, reconnection: true });
    socket = current;
    current.on('connect', schedule);
    current.on('disconnect', reason => {
        if (reason === 'io server disconnect') api('/me').then(() => {
            if (socket === current) current.connect();
        }).catch(() => {});
    });
    current.on('connect_error', () => api('/me').catch(() => {}));
    current.on('refresh', () => {
        schedule();
        if (page === 'monitor') void monitorPage.sync(true);
    });
    current.on('monitor:update', monitorPage.onUpdate);
    current.on('presence', schedule);
    current.on('new-task', () => { notify(); schedule(); });
}
function schedule(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>refresh().catch(e=>{if(user)toast(e.message)}),150);}
async function refresh(){
    if(!user)return;
    dirty=true;
    if(refreshPromise)return refreshPromise;
    refreshPromise=(async()=>{
        while(dirty&&user){
            dirty=false;
            const generation=sessionGeneration;
            const [t,u]=await Promise.all([api('/tasks'),isAdmin()?api('/users'):Promise.resolve([])]);
            if(generation!==sessionGeneration||!user)continue;
            tasks=t;users=u;
            taskClockSnapshot = performance.now();
            if(!isAdmin())for(const k of drafts.keys())if(!tasks.some(t=>String(t.id)===k.split(':')[0]&&!closed(t)&&owner(t)))drafts.delete(k);
            render();
            if(modal.open&&modalKind==='stages')stagesModal();
            if(modal.open&&modalKind==='suggested-task')showSuggestedTask(mc.querySelector('[data-task]')?.dataset.task);
        }
    })();
    try{await refreshPromise;}finally{refreshPromise=null;}
}
function heading(title,desc,extra=''){return `<div class="pagehead"><div><h1>${title}</h1><p class="muted">${desc}</p></div><div class="line">${extra}</div></div>`;}
// Update existing DOM nodes instead of replacing the entire screen on each socket event.
const reducedMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
function nodeKey(n){
    if(n.nodeType!==1)return null;
    if(n.id)return 'id:'+n.id;
    if(n.dataset.task)return 'task:'+n.dataset.task;
    if(n.dataset.monitorListing)return 'monitor-listing:'+n.dataset.monitorListing;
    if(n.dataset.monitorAccount)return 'monitor-account:'+n.dataset.monitorAccount;
    if(n.dataset.monitorAction)return 'monitor-action:'+n.dataset.monitorAction+':'+n.dataset.monitorId;
    if(n.dataset.draft)return 'draft:'+n.dataset.draft;
    if(n.dataset.act)return 'action:'+n.dataset.act+':'+(n.dataset.id||'');
    if(n.tagName==='INPUT'&&n.name)return 'input:'+n.name+(n.type==='radio'?':'+n.value:'');
    if(n.name)return 'name:'+n.name;
    if(n.classList.contains('person'))return 'person:'+n.querySelector('input')?.value;
    if(n.dataset.comment)return 'comment:'+n.dataset.comment;
    return null;
}
function compatible(a,b){return a&&a.nodeType===b.nodeType&&a.nodeName===b.nodeName&&nodeKey(a)===nodeKey(b);}
function patchNode(old,next){
    if(old.nodeType!==1){if(old.nodeValue!==next.nodeValue)old.nodeValue=next.nodeValue;return;}
    for(const a of [...old.attributes])if(!next.hasAttribute(a.name)&&!(old.tagName==='DETAILS'&&a.name==='open'))old.removeAttribute(a.name);
    for(const a of next.attributes)if(old.getAttribute(a.name)!==a.value)old.setAttribute(a.name,a.value);
    if(old.tagName==='INPUT'){
        if(old.type==='radio'||old.type==='checkbox')old.checked=next.checked;
        else if(old.value!==next.value)old.value=next.value;
        return;
    }
    if(old.tagName==='TEXTAREA'){
        if(old.value!==next.value)old.value=next.value;
        return;
    }
    patchChildren(old,next);
    if(old.tagName==='SELECT'&&old.value!==next.value)old.value=next.value;
}
function patchChildren(parent,next){
    const existing=[...parent.childNodes],used=new Set();
    let cursor=parent.firstChild;
    for(const desired of [...next.childNodes]){
        const k=nodeKey(desired);
        let match=k?existing.find(n=>!used.has(n)&&compatible(n,desired)):null;
        if(!k&&cursor&&!used.has(cursor)&&compatible(cursor,desired))match=cursor;
        if(!match&&!k)match=existing.find(n=>!used.has(n)&&compatible(n,desired));
        if(match){used.add(match);if(match!==cursor)parent.insertBefore(match,cursor);patchNode(match,desired);cursor=match.nextSibling;}
        else{const node=desired.cloneNode(true);parent.insertBefore(node,cursor);cursor=node.nextSibling;}
    }
    for(const n of existing)if(!used.has(n)&&n.parentNode===parent)n.remove();
}
function animateIn(el,delay=0){if(!reducedMotion())el.animate([{opacity:0,transform:'translateY(9px)'},{opacity:1,transform:'translateY(0)'}],{duration:240,delay,easing:'cubic-bezier(.2,.8,.2,1)',fill:'backwards'});}
function updateContent(root,html,{transition=false}={}){
    const next=document.createElement('template');next.innerHTML=html;
    if(transition){root.getAnimations().forEach(a=>a.cancel());root.replaceChildren(next.content);animateIn(root);return;}
    const motion=!reducedMotion(), before=new Map();
    const cards='[data-task],[data-monitor-listing]';
    if(motion)for(const card of root.querySelectorAll(cards))before.set(nodeKey(card),{card,rect:card.getBoundingClientRect()});
    const incoming=new Set([...next.content.querySelectorAll(cards)].map(nodeKey));
    if(motion)for(const [id,{card,rect}] of before)if(!incoming.has(id)&&rect.width&&rect.bottom>0&&rect.top<innerHeight){
        // Keep a brief non-interactive visual copy, without delaying access removal.
        const ghost=card.cloneNode(true);ghost.inert=true;ghost.setAttribute('aria-hidden','true');ghost.classList.add('task-ghost');
        Object.assign(ghost.style,{top:rect.top+'px',left:rect.left+'px',width:rect.width+'px',height:rect.height+'px'});
        // Modal ghosts must stay in the top layer; avoid clones inside modal entirely.
        if((root===main||root.id==='monitor-results')&&!modal.open){document.body.append(ghost);const a=ghost.animate([{opacity:1,transform:'translateY(0) scale(1)'},{opacity:0,transform:'translateY(-8px) scale(.985)'}],{duration:180,easing:'ease-out'});a.onfinish=a.oncancel=()=>ghost.remove();setTimeout(()=>ghost.remove(),300);}
    }
    const focused=document.activeElement,wasFocused=root.contains(focused);
    const selection=wasFocused&&typeof focused.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd,focused.selectionDirection]:null;
    patchChildren(root,next.content);
    if(wasFocused&&focused.isConnected&&document.activeElement!==focused){focused.focus({preventScroll:true});if(selection)try{focused.setSelectionRange(...selection);}catch{}}
    if(motion)for(const card of root.querySelectorAll(cards)){
        const old=before.get(nodeKey(card));if(!old){animateIn(card);continue;}
        const y=old.rect.top-card.getBoundingClientRect().top;
        if(Math.abs(y)>3)card.animate([{transform:`translateY(${y}px)`},{transform:'translateY(0)'}],{duration:260,easing:'cubic-bezier(.2,.8,.2,1)'});
    }
}
let lastPageKey='';
function render(){
    if(!user)return;
    const tabs=isAdmin()?[['home','Главная'],['stages','Этапы'],['clients','Клиенты'],['employees','Сотрудники'],['rating','Рейтинг'],['monitor','Мониторинг']]:[['mine','Мои задачи'],['common','Общие задачи']];
    updateContent(nav,tabs.map(([id,n])=>`<button data-act="page" data-id="${id}" class="${page===id?'active':''}" ${page===id?'aria-current="page"':''}>${n}${id==='monitor'?monitorPage.badge():''}</button>`).join(''));
    const key=sessionGeneration+':'+user.id+':'+page+(page==='clients'?':'+filter:'');
    const transition=lastPageKey!==key;
    lastPageKey=key;
    if (page==='monitor') {
        if (transition) {
            updateContent(main, monitorPage.shell(), { transition: true });
            monitorPage.enter();
            window.scrollTo({top:0,behavior:'instant'});
        }
        return;
    }
    const actual=main, staging=document.createElement('div');
    main=staging;
    try{switch(page){case'home':home();break;case'stages':stages();break;case'clients':clients();break;case'employees':employeesPage();break;case'rating':ratingPage();break;default:worker();}}finally{main=actual;}
    updateContent(main,staging.innerHTML,{transition});
    if(transition)window.scrollTo({top:0,behavior:'instant'});
}
const empty=txt=>`<div class="empty">${txt}</div>`;const opts=(values,current)=>values.map(v=>`<option value="${v}" ${v===current?'selected':''}>${labels[v]}</option>`).join('');
function home() {
    const d = newTaskDraft;
    main.innerHTML = heading('Распределение задач', 'Создайте задачу и назначьте ответственного сотрудника.') + `
        <form id="createTask" class="panel">
            <label for="task-direction">Направление задачи</label>
            <select id="task-direction" name="direction" required>
                ${d.monitor_listing_id && !d.direction ? '<option value="">Выберите направление</option>' : ''}
                ${opts(['selection','sale','rent'],d.direction??'selection')}
            </select>
            <div class="formgrid">
                <section class="panel">
                    <h2>Сотрудники</h2>
                    <input id="employeeSearch" aria-label="Поиск сотрудников" placeholder="Поиск по имени" value="${E(employeeSearch)}">
                    <div class="employees" id="employeeList">${employeeRadios()}</div>
                </section>
                <section class="panel">
                    <h2>Информация о клиенте</h2>
                    <div class="deal-fields">
                        <div>
                            <label for="task-deal">Тип сделки</label>
                            <select id="task-deal" name="deal" required>
                                ${d.monitor_listing_id && !d.deal ? '<option value="">Выберите тип</option>' : ''}
                                ${opts(['buy','sell','rent'],d.deal??'buy')}
                            </select>
                        </div>
                        <div>
                            <label for="task-property">Тип объекта</label>
                            <select id="task-property" name="property_type">
                                <option value="">Не указан</option>
                                ${Object.entries(propertyTypes).map(([value, label]) => `<option value="${value}" ${value===d.property_type?'selected':''}>${label}</option>`).join('')}
                            </select>
                        </div>
                    </div>
                    <label for="task-phone">Номер телефона</label>
                    <input id="task-phone" name="phone" type="tel" required maxlength="80" value="${E(d.phone)}">
                    <label for="task-address">Адрес объекта</label>
                    <input id="task-address" name="address" required maxlength="500" value="${E(d.address)}">
                    <label for="task-client">Имя клиента</label>
                    <input id="task-client" name="name" required maxlength="160" value="${E(d.name)}">
                </section>
            </div>
            ${monitorPage.taskInputs(d)}
            <button class="primary">Отправить задачу</button>
        </form>
        <section class="task-suggestions" id="task-suggestions" aria-live="polite">${taskSuggestions()}</section>`;
}

function taskSuggestions() {
    if (newTaskDraft.deal === '' || newTaskDraft.deal === 'rent') return '';
    const deal = newTaskDraft.deal === 'sell' ? 'buy' : 'sell';
    const type = newTaskDraft.property_type;
    const candidates = tasks.filter(task => task.deal === deal && !closed(task));
    const matches = type ? candidates.filter(task => task.property_type === type) : candidates;
    const unknown = type ? candidates.filter(task => !task.property_type) : [];
    const list = items => `<ul class="suggestion-list">${items.map(task => `
        <li>
            <div>
                <strong>${E(task.client_name)}</strong>
                <span>${[propertyTypes[task.property_type], task.address, task.phone].filter(Boolean).map(E).join(' · ')}</span>
            </div>
            ${button('Открыть заявку','suggested-task',task.id)}
        </li>`).join('')}</ul>`;
    return `<h2>${deal==='buy'?'Потенциальные покупатели':'Предложения на продажу'}</h2>
        ${matches.length ? list(matches) : empty('Подходящих открытых заявок нет')}
        ${unknown.length ? `<details class="untyped-suggestions" ${matches.length?'':'open'}><summary>Заявки без указанного типа (${unknown.length})</summary>${list(unknown)}</details>` : ''}`;
}

function showSuggestedTask(id) {
    const task = tasks.find(task => String(task.id) === id && !closed(task));
    if (!isAdmin() || !task) {
        if (modalKind === 'suggested-task') modal.close();
        return;
    }
    openModal('suggested-task', modalHead('Заявка №' + task.id) + taskCard(task, { expanded: true }));
}

function taskStage(task) {
    const current = task.timeline?.current;
    if (current === 'waiting') return { step: 'waiting', label: task.is_new ? 'Новая' : 'Ожидает назначения', style: 'new' };
    if (current === 'working') return { step: 'working', label: 'В работе', style: 'working' };
    if (task.result !== 'none') return { step: 'result', label: labels[task.result], style: task.result };
    if (task.comments.some(comment => comment.kind === 'done')) return { step: 'done', label: 'Проделанная работа', style: 'done' };
    if (task.is_new && !task.comments.length) return { step: 'waiting', label: 'Новая', style: 'new' };
    return { step: 'working', label: 'В работе', style: 'working' };
}

function taskCard(task, { expanded = false } = {}) {
    const title = `<strong>Задача №${task.id} · ${E(task.client_name)}</strong>`;
    const stage = isAdmin() ? taskStage(task) : {
        label: task.is_new ? 'НОВАЯ' : task.result === 'none' ? 'В работе' : labels[task.result],
        style: task.is_new ? 'new' : task.result
    };
    const badge = `<span class="tag ${stage.style}">${stage.label}</span>`;
    const date = `<small>${fmt(task.created_at)}</small>`;
    if (!isAdmin() || expanded) {
        return `<article class="task" data-task="${task.id}"><div class="taskhead">${title}<div class="line">${date}${badge}</div></div>${taskDetails(task)}</article>`;
    }
    const meta = [labels[task.deal], propertyTypes[task.property_type], task.address, task.owner_name || 'Не назначен'].filter(Boolean).map(E).join(' · ');
    return `<details class="task compact-task" data-task="${task.id}">
        <summary class="taskhead">
            <div>${title}<div class="muted task-summary-meta">${meta}</div></div>
            <div class="line">${date}${badge}<span class="task-chevron" aria-hidden="true"></span></div>
        </summary>
        ${taskDetails(task)}
    </details>`;
}
function employeeRadios(){return `<label class="person"><input type="radio" name="target" value="all" ${!newTaskDraft.target||newTaskDraft.target==='all'?'checked':''}> Всем сотрудникам</label>`+users.filter(u=>u.name.toLowerCase().includes(employeeSearch.toLowerCase())||String(u.id)===newTaskDraft.target).map(u=>`<label class="person"><input type="radio" name="target" value="${u.id}" ${String(u.id)===newTaskDraft.target?'checked':''}> ${E(u.name)} <span class="${u.online?'online':'muted'}">● ${u.online?'Онлайн':'Офлайн'}</span></label>`).join('');}
function stages(){main.innerHTML=heading('Этапы','Выберите сотрудника, чтобы открыть его задачи.')+`<div class="tiles">${users.map(u=>`<button class="tile" data-act="stages" data-id="${u.id}"><strong>${E(u.name)}</strong><span class="${u.online?'online':'muted'}">● ${u.online?'Онлайн':'Офлайн'}</span><p class="muted">Задач: ${tasks.filter(t=>String(t.owner_id)===String(u.id)).length}</p></button>`).join('')||empty('Нет сотрудников')}</div>`;}
function openModal(kind,html,small=false){const same=modal.open&&modalKind===kind;modalKind=kind;modal.className=small?'small':'';updateContent(mc,html,{transition:!same});if(!modal.open)modal.showModal();}const modalHead=t=>`<div class="pagehead"><h2>${t}</h2>${button('✕','close','','flat')}</div>`;
function stagesModal(){const u=users.find(u=>String(u.id)===String(selectedEmployee));if(!u){modal.close();return;}const focus=document.activeElement?.dataset?.draft;openModal('stages',modalHead(E(u.name))+tasks.filter(t=>String(t.owner_id)===String(u.id)).map(task=>taskCard(task)).join('')+(tasks.some(t=>String(t.owner_id)===String(u.id))?'':empty('Нет задач')));if(focus&&document.activeElement?.dataset?.draft!==focus){[...mc.querySelectorAll('[data-draft]')].find(el=>el.dataset.draft===focus)?.focus({preventScroll:true});}}
function clients(){const s=clientSearch.toLowerCase().trim(),digits=s.replace(/\D/g,'');const visible=tasks.filter(t=>(filter==='completed')===closed(t)&&(!s||t.client_name.toLowerCase().includes(s)||t.phone.toLowerCase().includes(s)||(digits&&t.phone.replace(/\D/g,'').includes(digits))));main.innerHTML=heading('Клиенты','Единая база задач. Новые задачи в приоритете.',button('Экспорт Excel','export','','primary')+button('Журнал действий','audit'))+`<div class="tabs">${button('В работе ('+tasks.filter(t=>!closed(t)).length+')','filter','active',filter==='active'?'active':'')}${button('Завершённые ('+tasks.filter(closed).length+')','filter','completed',filter==='completed'?'active':'')}</div><input id="clientSearch" placeholder="Поиск по имени или телефону" value="${E(clientSearch)}"><br><br>${visible.map(task=>taskCard(task)).join('')||empty('Клиенты не найдены')}`;}
function employeesPage(){main.innerHTML=heading('Сотрудники','Управление учётными записями.',button('+ Добавить сотрудника','add-user','','primary')+button('Журнал действий','audit'))+`<div class="panel tablewrap"><table class="table"><thead><tr><th>Имя</th><th>Логин</th><th>Статус</th><th>Действия</th></tr></thead><tbody>${users.map(u=>`<tr><td>${E(u.name)}</td><td>${E(u.login)}</td><td class="${u.online?'online':'muted'}">● ${u.online?'Онлайн':'Офлайн'}</td><td>${button('Изменить','edit-user',u.id)} ${button('Удалить','delete-user',u.id,'danger')}</td></tr>`).join('')}</tbody></table>${users.length?'':empty('Добавьте первого сотрудника')}</div>`;}
function worker(){const visible=tasks.filter(t=>!closed(t)&&(page==='common'?t.scope==='common':owner(t)));main.innerHTML=heading(page==='common'?'Общие задачи':'Мои задачи',page==='common'?'Активные общие задачи видны всем сотрудникам.':'Активные личные и принятые общие задачи.')+visible.map(task=>taskCard(task)).join('')+(visible.length?'':empty('Задач пока нет'));}
function field(label,value){return `<p class="data"><small>${label}</small>${E(value||'—')}</p>`;}
const ratingMonthFormatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit'
});
const ratingPeriodLabel = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: 'long'
});
let shownRatingMonth;

function ratingPeriod(now = new Date()) {
    const parts = Object.fromEntries(ratingMonthFormatter.formatToParts(now).map(({ type, value }) => [type, value]));
    return {
        start: parts.year + '-' + parts.month + '-01',
        end: new Date(Date.UTC(Number(parts.year), Number(parts.month), 1)).toISOString().slice(0, 10)
    };
}

function ratingPage() {
    const now = new Date();
    const { start, end } = ratingPeriod(now);
    shownRatingMonth = start;
    const scores = new Map(users.map(user => [String(user.id), { ...user, success: 0, failed: 0 }]));
    for (const task of tasks) {
        const employee = scores.get(String(task.owner_id));
        if (employee && closed(task) && task.result_date >= start && task.result_date < end) {
            employee[task.result]++;
        }
    }

    function leaderboard(result, title, message) {
        const ranking = [...scores.values()].filter(employee => employee[result] > 0)
            .sort((a, b) => b[result] - a[result] || a.name.localeCompare(b.name, 'ru'));
        let place = 0;
        const list = ranking.map((employee, index) => {
            if (ranking[index - 1]?.[result] !== employee[result]) place = index + 1;
            return `<li data-rank-employee="${E(employee.id)}">
                <span class="rating-place" aria-label="Место ${place}">${place}</span>
                <strong>${E(employee.name)}</strong>
                <span class="tag ${result}">${employee[result]}</span>
            </li>`;
        }).join('');
        return `<section class="panel rating-list" data-rating="${result}"><h2>${title}</h2>
            ${list ? '<ol>' + list + '</ol>' : empty(message)}
        </section>`;
    }

    const period = ratingPeriodLabel.format(now);
    main.innerHTML = heading('Рейтинг сотрудников', `За ${period} Сделки учитываются по дате результата.`) +
        `<div class="rating-grid">
            ${leaderboard('success', 'Успешные сделки', 'Пока нет успешных сделок')}
            ${leaderboard('failed', 'Сорванные сделки', 'Пока нет сорванных сделок')}
        </div>`;
}

function formatTaskTime(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms < 60000) return '< 1 мин';
    const minutes = Math.floor(ms / 60000);
    return [
        minutes >= 1440 ? Math.floor(minutes / 1440) + ' д' : '',
        Math.floor(minutes / 60) % 24 ? Math.floor(minutes / 60) % 24 + ' ч' : '',
        minutes % 60 ? minutes % 60 + ' мин' : ''
    ].filter(Boolean).join(' ');
}

function updateTaskClocks() {
    const elapsed = Math.max(0, performance.now() - taskClockSnapshot);
    document.querySelectorAll('[data-running-ms]').forEach(clock => {
        clock.textContent = formatTaskTime(Number(clock.dataset.runningMs) + elapsed);
    });
}

setInterval(() => {
    updateTaskClocks();
    if (user && page === 'rating' && shownRatingMonth !== ratingPeriod().start) render();
}, 15000);

function taskDetails(task) {
    const stage = taskStage(task);
    const edit = editable(task);
    const name = task.owner_name ? task.owner_name + (task.owner_active ? '' : ' (удалён)') : 'Не назначен';
    function block(key, title, html) {
        const duration = task.timeline?.durations[key];
        const running = task.timeline?.current === key;
        const hint = !task.timeline ? 'В журнале недостаточно данных для расчёта' :
            key === 'waiting' ? 'Время ожидания назначения' : 'Время на этапе';
        return `<section class="block" ${stage.step===key?'data-current-stage':''}>
            <div class="task-block-head"><h3>${title}</h3>
                <span class="task-clock" title="${hint}" ${running?`data-running-ms="${duration}"`:''}>${E(formatTaskTime(duration))}</span>
            </div>
            ${html}
        </section>`;
    }
    function comments(kind) {
        const key = task.id + ':' + kind;
        const list = task.comments.filter(comment => comment.kind === kind).map(comment => `
            <div class="comment" data-comment="${comment.id}">${E(comment.body)}
                <small>${E(comment.author_name)} · ${fmt(comment.created_at)}</small>
            </div>`).join('');
        return `<div class="comments">${list || '<small>Комментариев нет</small>'}</div>
            ${edit ? `<textarea data-draft="${key}" rows="2" aria-label="Комментарий" placeholder="Добавить комментарий">${E(drafts.get(key) || '')}</textarea>
                ${button('Сохранить комментарий', 'comment-' + kind, task.id)}` : ''}`;
    }

    const resultKey = task.id + ':result';
    const dateKey = task.id + ':date';
    const result = drafts.get(resultKey) || task.result;
    const date = drafts.has(dateKey) ? drafts.get(dateKey) : dateOnly(task.result_date);
    const source = monitorPage.taskDetails(task);
    const info = `<div class="task-facts">
        ${field('Ответственный', name)}
        ${field('Телефон', task.phone)}
        ${field('Направление', labels[task.direction])}
        ${field('Тип сделки', labels[task.deal])}
        ${task.property_type ? field('Тип объекта', propertyTypes[task.property_type]) : ''}
        ${field('Доступ', task.scope==='common'?'Общая задача':'Личная задача')}
        <div class="task-address">${field('Адрес объекта', task.address)}</div>
    </div>
    ${source ? '<div class="task-source">' + source + '</div>' : ''}
    ${!isAdmin() && task.scope==='common' && !task.owner_id && !closed(task) ? button('Взять в работу','claim',task.id,'primary') : ''}`;
    const resultForm = edit ? `<label>Статус сделки<select data-draft="${resultKey}">${opts(['none','success','failed','postponed'],result)}</select></label>
        <label>Дата сделки / переноса<input type="date" data-draft="${dateKey}" value="${E(date)}"></label>
        ${button('Сохранить результат','result',task.id,'primary')}` : field('Статус', labels[task.result]) + field('Дата', dateOnly(task.result_date));
    const actions = isAdmin() ? `<div class="taskfoot">
        ${!closed(task) ? button(task.owner_id?'Передать сотруднику':'Назначить сотрудника','assign',task.id) +
            (task.owner_id ? button('Забрать задачу','revoke',task.id) : '') : ''}
        ${button('Удалить задачу','delete-task',task.id,'danger')}
    </div>` : '';
    return `<div class="four">
        ${block('waiting', 'Карточка задачи', info)}
        ${block('working', 'В работе', comments('working'))}
        ${block('done', 'Проделанная работа', comments('done'))}
        ${block('result', 'Результат сделки', resultForm)}
    </div>${actions}`;
}
function editUser(u){openModal('user',modalHead(u?'Изменить сотрудника':'Добавить сотрудника')+`<form id="userForm" data-id="${u?.id||''}"><label>Имя и фамилия</label><input name="name" required value="${E(u?.name)}"><label>Логин</label><input name="login" required value="${E(u?.login)}"><label>${u?'Новый пароль (необязательно)':'Пароль (от 8 символов)'}</label><input name="password" type="password" ${u?'':'required'} minlength="8" autocomplete="new-password"><br><br><button class="primary">Сохранить</button></form>`,true);}
function assignment(t){const list=users.filter(u=>String(u.id)!==String(t.owner_id));openModal('assign',modalHead('Назначить задачу №'+t.id)+`<form id="assignForm" data-id="${t.id}"><label>Сотрудник</label><select name="owner_id" required><option value="">Выберите сотрудника</option>${list.map(u=>`<option value="${u.id}">${E(u.name)}</option>`).join('')}</select><br><br><button class="primary" ${list.length?'':'disabled'}>Назначить</button></form>`,true);}
async function exportFile(){const r=await fetch('/api/export',{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw Error('Ошибка экспорта');const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=url;a.download='EVRIKA-clients.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
async function auditView(){const data=await api('/audit');openModal('audit',modalHead('Журнал действий')+`<p class="muted">Последние 500 событий</p><div class="tablewrap"><table class="table"><thead><tr><th>Дата</th><th>Пользователь</th><th>Действие</th><th>Задача</th><th>Детали</th></tr></thead><tbody>${data.map(a=>`<tr><td>${fmt(a.created_at)}</td><td>${E(a.actor_name)}</td><td>${E(labels[a.action]||a.action)}</td><td>${E(a.task_id||'—')}</td><td>${E(JSON.stringify(a.details))}</td></tr>`).join('')}</tbody></table></div>`);}
function settings() {
    const account = isAdmin() ? `
        <form id="admin-credentials" class="account-settings">
            <h3>Учётная запись</h3>
            <label for="admin-login">Логин</label>
            <input id="admin-login" name="login" autocomplete="username" maxlength="100" value="${E(user.login)}" required>
            <label for="admin-current-password">Текущий пароль</label>
            <input id="admin-current-password" name="currentPassword" type="password" autocomplete="current-password" required>
            <label for="admin-new-password">Новый пароль (если нужно изменить)</label>
            <input id="admin-new-password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="72">
            <p class="form-error" role="alert" hidden></p>
            <button class="primary" type="submit">Сохранить</button>
        </form>` : '';
    const utilities = window.evrika ? [
        button('Полноэкранный / оконный режим','fullscreen'),
        button('Свернуть','minimize'),
        button('Адрес сервера','server-settings')
    ].join('') : `<p class="muted">В браузере используйте F11 для полноэкранного режима.</p>${'Notification' in window ? button('Разрешить уведомления','notifications') : ''}`;
    openModal('settings', modalHead('Настройки') + account + `<div class="line settings-actions">${utilities}</div>`, true);
}

function showThemes() {
    const current = document.body.dataset.theme;
    const options = Object.entries(themes).map(([value, name]) => `
        <label class="theme-option">
            <input type="radio" name="theme" value="${value}" ${value===current?'checked':''}>
            <span class="theme-swatch theme-${value}" aria-hidden="true"></span>
            <span>${name}</span>
        </label>`).join('');
    openModal('themes', modalHead('Тема оформления') + `<div class="theme-options" role="radiogroup" aria-label="Тема оформления">${options}</div>`, true);
}

async function updateAdminCredentials(data) {
    const previousLogin = user.login;
    const generation = sessionGeneration;
    socket?.disconnect();
    try {
        const result = await api('/me/credentials', 'PATCH', data);
        if (generation !== sessionGeneration) return;
        token = result.token;
        sessionStorage.setItem('evrika-token', token);
        const preference = localStorage.getItem('evrika-theme-' + previousLogin);
        user = result.user;
        if (preference && previousLogin !== user.login) localStorage.setItem('evrika-theme-' + user.login, preference);
        theme();
        modal.close();
        let notice = 'Данные для входа обновлены';
        try {
            const saved = await window.evrika?.readCredentials?.();
            if (saved?.login?.trim().toLowerCase() === previousLogin) {
                await window.evrika.writeCredentials({ login: result.user.login, password: data.password || data.currentPassword });
            }
        } catch {
            notice = 'Данные обновлены. Повторно сохраните их при входе в приложение';
        }
        if (generation === sessionGeneration) toast(notice);
    } finally {
        if (generation === sessionGeneration) connect();
    }
}

async function mutate(url,method='POST',data){await api(url,method,data);await refresh();toast('Изменения сохранены');}
document.addEventListener('input',e=>{const el=e.target;if(el.dataset.draft){drafts.set(el.dataset.draft,el.value);return;}if(el.id==='employeeSearch'){employeeSearch=el.value;updateContent($('#employeeList'),employeeRadios());return;}if(el.id==='clientSearch'){clientSearch=el.value;render();return;}if(el.closest('#createTask')&&el.name)newTaskDraft[el.name]=el.value;});
document.addEventListener('change',e=>{const el=e.target;if(el.name==='theme'&&Object.hasOwn(themes,el.value)){localStorage.setItem('evrika-theme-'+(user?.login||'guest'),el.value);theme();}if(el.dataset.draft)drafts.set(el.dataset.draft,el.value);if(el.closest('#createTask')&&el.name){newTaskDraft[el.name]=el.value;if(['deal','property_type'].includes(el.name))updateContent($('#task-suggestions'),taskSuggestions());}});
document.addEventListener('submit',async e=>{const form=e.target;if(!['loginForm','createTask','userForm','assignForm','admin-credentials'].includes(form.id))return;e.preventDefault();const b=Object.fromEntries(new FormData(form)),btn=form.querySelector('button[type=submit],button:not([type])');if(btn)btn.disabled=true;const error=form.querySelector('.form-error');if(error)error.hidden=true;try{if(form.id==='loginForm'){await signIn(b);}else if(form.id==='admin-credentials'){await updateAdminCredentials(b);}else if(form.id==='createTask'){await api('/tasks','POST',{...b,scope:b.target==='all'?'common':'personal',owner_id:b.target==='all'?null:b.target});newTaskDraft={};employeeSearch='';await refresh();toast('Задача отправлена');}else if(form.id==='userForm'){await api('/users'+(form.dataset.id?'/'+form.dataset.id:''),form.dataset.id?'PATCH':'POST',b);modal.close();await refresh();toast('Сотрудник сохранён');}else if(form.id==='assignForm'){await api('/tasks/'+form.dataset.id+'/assign','POST',b);modal.close();await refresh();toast('Задача назначена');}}catch(err){if(error){error.textContent=err.message;error.hidden=false;}else toast(err.message);}finally{if(btn)btn.disabled=false;}});
document.addEventListener('click',async e=>{const el=e.target.closest('button');if(!el)return;const act=el.dataset.act,tid=el.dataset.id;if(!act)return;const t=tasks.find(t=>String(t.id)===tid);try{switch(act){case'page':page=tid;render();break;case'filter':filter=tid;render();break;case'stages':selectedEmployee=tid;stagesModal();break;case'suggested-task':showSuggestedTask(tid);break;case'close':modal.close();break;case'add-user':editUser(null);break;case'edit-user':editUser(users.find(u=>String(u.id)===tid));break;case'delete-user':if(confirm('Удалить сотрудника? Все задачи и история останутся в базе, доступ будет прекращён.'))await mutate('/users/'+tid,'DELETE');break;case'claim':el.disabled=true;await mutate('/tasks/'+tid+'/claim');break;case'assign':if(t)assignment(t);break;case'revoke':if(confirm(t.scope==='common'?'Освободить общую задачу?':'Вернуть личную задачу администратору?'))await mutate('/tasks/'+tid+'/assign','POST',{owner_id:null});break;case'delete-task':if(confirm('Удалить задачу из клиентской базы?'))await mutate('/tasks/'+tid,'DELETE');break;case'comment-working':case'comment-done':{const kind=act.slice(8),k=tid+':'+kind,body=drafts.get(k);if(!body?.trim())throw Error('Введите комментарий');el.disabled=true;await api('/tasks/'+tid+'/comment','POST',{kind,body});drafts.delete(k);await refresh();toast('Комментарий сохранён');break;}case'result':{const result=drafts.get(tid+':result')||t.result,date=drafts.has(tid+':date')?drafts.get(tid+':date'):dateOnly(t.result_date);if(result!=='none'&&!date)throw Error('Выберите дату');el.disabled=true;await api('/tasks/'+tid+'/result','POST',{result,date,revision:t.revision});drafts.delete(tid+':result');drafts.delete(tid+':date');await refresh();toast(['success','failed'].includes(result)?'Задача завершена и сохранена в разделе «Клиенты → Завершённые»':'Результат сохранён');break;}case'export':await exportFile();break;case'audit':await auditView();break;case'fullscreen':await window.evrika.fullscreen();break;case'minimize':await window.evrika.minimize();break;case'server-settings':await window.evrika.configure();break;case'notifications':await Notification.requestPermission();break;}}catch(err){toast(err.message);if(user)schedule();}finally{el.disabled=false;}});
$('#settings').addEventListener('click',settings);$('#theme-button').addEventListener('click',showThemes);$('#logout').addEventListener('click',()=>logout());$('#brand').addEventListener('click',()=>{if(user){page=isAdmin()?'home':'mine';render();}});modal.addEventListener('close',()=>{modalKind='';});
(async()=>{if(token){try{await start(await api('/me'));}catch(e){logout();toast(e.message);}}else loginScreen();})();
