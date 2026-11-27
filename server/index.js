const {pool,tx}=require('./db');const {finished,canView,canEdit,canClaim}=require('./rules');
const express=require('express'),helmet=require('helmet'),jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs'),{rateLimit}=require('express-rate-limit'),Excel=require('exceljs'),{Server}=require('socket.io'),fs=require('fs'),path=require('path');
const secret=process.env.JWT_SECRET;if(!secret||secret.length<32)throw Error('JWT_SECRET должен содержать не менее 32 символов. Выполните настройку.');
const app=express();const tls=process.env.TLS_CERT&&process.env.TLS_KEY;const server=tls?require('https').createServer({cert:fs.readFileSync(process.env.TLS_CERT),key:fs.readFileSync(process.env.TLS_KEY)},app):require('http').createServer(app);const io=new Server(server);const online=new Map();
const monitorRoutes = require('./monitor/routes');
const monitor = require('./monitor/service').createService({ pool, tx, emit: event => io.to('admins').emit('monitor:update', event) });
const { migrate: migrateMonitor } = require('./monitor/store');
const fail=(status,message)=>Object.assign(new Error(message),{status});const text=(v,max=2000)=>typeof v==='string'?v.trim().slice(0,max):'';const id=v=>{if(!/^\d{1,15}$/.test(String(v)))throw fail(400,'Некорректный ID');return String(v)};const required=(v,label,max)=>{v=text(v,max);if(!v)throw fail(400,'Заполните: '+label);return v};const one=(v,values)=>{if(!values.includes(v))throw fail(400,'Недопустимое значение');return v};
const safe=u=>({id:u.id,name:u.name,login:u.login,role:u.role,active:u.active});
const session=u=>({user:safe(u),token:jwt.sign({ver:u.token_version},secret,{subject:String(u.id),expiresIn:'12h',algorithm:'HS256'})});
const propertyTypes=['house','apartment','land','commercial','other'];
async function verify(token){let claims;try{claims=jwt.verify(token,secret,{algorithms:['HS256']});}catch{throw fail(401,'Войдите снова');}const {rows:[u]}=await pool.query('SELECT * FROM users WHERE id=$1 AND active',[claims.sub]);if(!u||u.token_version!==claims.ver)throw fail(401,'Доступ прекращён. Войдите снова');return u;}
const auth=async(req,res,next)=>{try{req.user=await verify((req.headers.authorization||'').replace(/^Bearer /,''));next();}catch(e){next(e);}};const admin=(req,res,next)=>req.user.role==='admin'?next():next(fail(403,'Только администратор'));
async function audit(c,u,action,task=null,details={}){await c.query('INSERT INTO audit(actor_id,actor_name,action,task_id,details,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())',[u.id,u.name,action,task,JSON.stringify(details)]);}
function change(){io.emit('refresh');}function presence(){io.to('admins').emit('presence',[...online.keys()]);}function disconnectUser(uid){io.in('user:'+uid).disconnectSockets(true);}
const { taskTimeline } = require('./task-timeline');

async function tasks(user, withTimeline = false) {
  const history = withTimeline ? `, COALESCE((
      SELECT json_agg(json_build_object('action', a.action, 'created_at', a.created_at, 'details', a.details) ORDER BY a.id)
      FROM audit a WHERE a.task_id=t.id
      AND a.action IN ('task_create','task_assign','task_claim','task_revoke','comment_done','task_result')
    ), '[]'::json) AS stage_history` : '';
  const { rows } = await pool.query(`
    SELECT t.*,t.result_date::text AS result_date,c.name AS client_name,c.phone,c.address,
      u.name AS owner_name,u.active AS owner_active,mt.url AS monitor_url,
      mt.description AS monitor_description,mt.price AS monitor_price,
      COALESCE((
        SELECT json_agg(json_build_object('id',m.id,'kind',m.kind,'body',m.body,'author_name',m.author_name,'created_at',m.created_at) ORDER BY m.id)
        FROM comments m WHERE m.task_id=t.id
      ), '[]'::json) AS comments${history}
    FROM tasks t JOIN clients c ON c.id=t.client_id LEFT JOIN users u ON u.id=t.owner_id
    LEFT JOIN monitor_task_details mt ON mt.task_id=t.id
    WHERE t.deleted_at IS NULL AND ($1='admin' OR (t.result NOT IN ('success','failed') AND (t.scope='common' OR t.owner_id=$2)))
    ORDER BY t.is_new DESC,t.created_at DESC,t.id DESC`, [user.role, user.id]);
  if (!withTimeline) return rows;
  const now = Date.now();
  return rows.map(({ stage_history, ...task }) => ({ ...task, timeline: taskTimeline(task, stage_history, now) }));
}
async function lock(c,tid){const {rows:[t]}=await c.query('SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id(tid)]);if(!t)throw fail(404,'Задача не найдена');return t;}
async function employee(c,uid){const {rows:[u]}=await c.query("SELECT id FROM users WHERE id=$1 AND role='employee' AND active FOR SHARE",[id(uid)]);if(!u)throw fail(400,'Сотрудник недоступен');return u.id;}
app.disable('x-powered-by');app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'","data:",'https://avito.st','https://*.avito.st'],connectSrc:["'self'"],mediaSrc:["'self'"],upgradeInsecureRequests:null}},strictTransportSecurity:!!tls}));app.use(express.json({limit:'256kb'}));
app.get('/api/health',async(req,res)=>{await pool.query('SELECT 1');res.json({ok:true,database:'PostgreSQL',app:'EVRIKA CRM'});});
app.post('/api/login',rateLimit({windowMs:15*60*1000,limit:40,standardHeaders:true,legacyHeaders:false}),async(req,res)=>{const login=text(req.body.login,100).toLowerCase(),pass=typeof req.body.password==='string'?req.body.password.slice(0,200):'';const {rows:[u]}=await pool.query('SELECT * FROM users WHERE login=$1 AND active',[login]);if(!u||!await bcrypt.compare(pass,u.password_hash))throw fail(401,'Неверный логин или пароль');await audit(pool,u,'login');res.json(session(u));});
app.use('/api',auth);
app.use('/api/monitor', admin, monitorRoutes.router({ pool, tx, service: monitor }));
app.get('/api/me',(req,res)=>res.json(safe(req.user)));
app.patch('/api/me/credentials', admin, rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  keyGenerator: req => String(req.user.id),
  standardHeaders: true,
  legacyHeaders: false
}), async (req, res) => {
  const login = required(req.body.login, 'Логин', 100).toLowerCase();
  const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword.slice(0, 200) : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password && (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72)) {
    throw fail(400, 'Новый пароль должен содержать минимум 8 символов и занимать до 72 байт');
  }
  if (!currentPassword || !await bcrypt.compare(currentPassword, req.user.password_hash)) {
    throw fail(403, 'Текущий пароль неверный');
  }
  if (login === req.user.login && !password) return res.json(session(req.user));
  const hash = password ? await bcrypt.hash(password, 12) : req.user.password_hash;
  const updated = await tx(async c => {
    const { rows: [u] } = await c.query(
      'UPDATE users SET login=$2, password_hash=$3, token_version=token_version+1 WHERE id=$1 AND token_version=$4 AND active RETURNING *',
      [req.user.id, login, hash, req.user.token_version]
    );
    if (!u) throw fail(409, 'Учётная запись уже изменилась. Войдите снова');
    await audit(c, u, 'admin_credentials', null, { loginChanged: login !== req.user.login, passwordChanged: !!password });
    return u;
  });
  for (const socketId of io.sockets.adapter.rooms.get('user:' + updated.id) || []) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket?.user.token_version === req.user.token_version) socket.disconnect(true);
  }
  res.json(session(updated));
});
app.get('/api/tasks',async(req,res)=>res.json(await tasks(req.user, true)));
app.get('/api/users',admin,async(req,res)=>{const {rows}=await pool.query("SELECT id,name,login,role,active FROM users WHERE role='employee' AND active ORDER BY name,id");res.json(rows.map(u=>({...u,online:online.has(String(u.id))})));});
app.post('/api/users',admin,async(req,res)=>{const name=required(req.body.name,'Имя',160),login=required(req.body.login,'Логин',100).toLowerCase(),password=typeof req.body.password==='string'?req.body.password.slice(0,200):'';if(password.length<8)throw fail(400,'Пароль: минимум 8 символов');await tx(async c=>{const {rows:[u]}=await c.query("INSERT INTO users(name,login,password_hash,role) VALUES($1,$2,$3,'employee') RETURNING id",[name,login,await bcrypt.hash(password,12)]);await audit(c,req.user,'employee_create',null,{id:u.id,name});});change();res.json({ok:true});});
app.patch('/api/users/:id',admin,async(req,res)=>{const uid=id(req.params.id),name=required(req.body.name,'Имя',160),login=required(req.body.login,'Логин',100).toLowerCase(),pass=typeof req.body.password==='string'?req.body.password.slice(0,200):'';if(pass&&pass.length<8)throw fail(400,'Пароль: минимум 8 символов');await tx(async c=>{const hash=pass?await bcrypt.hash(pass,12):null;const r=await c.query("UPDATE users SET name=$2,login=$3,password_hash=COALESCE($4,password_hash),token_version=token_version+CASE WHEN $4::text IS NULL THEN 0 ELSE 1 END WHERE id=$1 AND role='employee' AND active",[uid,name,login,hash]);if(!r.rowCount)throw fail(404,'Сотрудник не найден');await audit(c,req.user,'employee_edit',null,{id:uid,name});});if(pass)disconnectUser(uid);change();res.json({ok:true});});
app.delete('/api/users/:id',admin,async(req,res)=>{const uid=id(req.params.id);await tx(async c=>{const r=await c.query("UPDATE users SET active=false,token_version=token_version+1 WHERE id=$1 AND role='employee' AND active RETURNING name",[uid]);if(!r.rowCount)throw fail(404,'Сотрудник не найден');await audit(c,req.user,'employee_delete',null,{id:uid,name:r.rows[0].name});});disconnectUser(uid);change();res.json({ok:true});});
app.post('/api/tasks', admin, async (req, res) => {
  const b = req.body;
  const scope = one(b.scope, ['common', 'personal']);
  const direction = one(b.direction, ['selection', 'sale', 'rent']);
  const deal = one(b.deal, ['buy', 'sell', 'rent']);
  const name = required(b.name, 'Имя клиента', 160);
  const phone = required(b.phone, 'Телефон', 80);
  const address = required(b.address, 'Адрес объекта', 500);
  const propertyType = b.property_type ? one(b.property_type, propertyTypes) : null;
  const source = monitorRoutes.parseTaskOptions(b);
  const task = await tx(async c => {
    if (source) await monitorRoutes.lockListingForTask(c, source.listingId);
    const owner = scope === 'personal' ? await employee(c, b.owner_id) : null;
    const { rows: [client] } = await c.query(
      'INSERT INTO clients(name,phone,address) VALUES($1,$2,$3) RETURNING id', [name, phone, address]
    );
    const { rows: [created] } = await c.query(
      'INSERT INTO tasks(client_id,scope,owner_id,direction,deal,property_type) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [client.id, scope, owner, direction, deal, propertyType]
    );
    if (source) await monitorRoutes.linkTask(c, created.id, source, req.user.id);
    await audit(c, req.user, 'task_create', created.id, { scope, owner });
    return created;
  });
  io.to(scope === 'common' ? 'employees' : 'user:' + task.owner_id).emit('new-task', { id: task.id });
  if (source) monitor.notify(0, true);
  change();
  res.json({ ok: true, id: task.id });
});
app.post('/api/tasks/:id/claim',async(req,res)=>{await tx(async c=>{const t=await lock(c,req.params.id);if(!canClaim(req.user,t))throw fail(409,'Задача уже занята или недоступна');await c.query('UPDATE tasks SET owner_id=$2,is_new=false,revision=revision+1,updated_at=now() WHERE id=$1',[t.id,req.user.id]);await audit(c,req.user,'task_claim',t.id);});change();res.json({ok:true});});
app.post('/api/tasks/:id/assign',admin,async(req,res)=>{const result=await tx(async c=>{const t=await lock(c,req.params.id);if(finished(t))throw fail(409,'Завершённая задача');const owner=req.body.owner_id==null?null:await employee(c,req.body.owner_id);await c.query('UPDATE tasks SET owner_id=$2,is_new=$3,revision=revision+1,updated_at=now() WHERE id=$1',[t.id,owner,!owner||t.scope==='personal']);await audit(c,req.user,owner?'task_assign':'task_revoke',t.id,{from:t.owner_id,to:owner});return {id:t.id,owner};});if(result.owner)io.to('user:'+result.owner).emit('new-task',{id:result.id});change();res.json({ok:true});});
app.post('/api/tasks/:id/comment',async(req,res)=>{const kind=one(req.body.kind,['working','done']),body=required(req.body.body,'Комментарий',10000);await tx(async c=>{const t=await lock(c,req.params.id);if(!canEdit(req.user,t))throw fail(403,'Нет права редактировать');await c.query('INSERT INTO comments(task_id,author_id,author_name,kind,body) VALUES($1,$2,$3,$4,$5)',[t.id,req.user.id,req.user.name,kind,body]);await c.query('UPDATE tasks SET is_new=false,revision=revision+1,updated_at=now() WHERE id=$1',[t.id]);await audit(c,req.user,'comment_'+kind,t.id);});change();res.json({ok:true});});
app.post('/api/tasks/:id/result',async(req,res)=>{const result=one(req.body.result,['none','success','failed','postponed']),date=result==='none'?null:text(req.body.date,10);if(result!=='none'&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))throw fail(400,'Выберите корректную дату');await tx(async c=>{const t=await lock(c,req.params.id);if(!canEdit(req.user,t))throw fail(403,'Нет права редактировать');if(Number(req.body.revision)!==t.revision)throw fail(409,'Задача изменилась. Обновите данные');await c.query('UPDATE tasks SET result=$2,result_date=$3,is_new=false,revision=revision+1,updated_at=now() WHERE id=$1',[t.id,result,date]);await audit(c,req.user,'task_result',t.id,{from:t.result,to:result,date});});change();res.json({ok:true});});
app.delete('/api/tasks/:id',admin,async(req,res)=>{await tx(async c=>{const t=await lock(c,req.params.id);await c.query('UPDATE tasks SET deleted_at=now(),revision=revision+1 WHERE id=$1',[t.id]);await audit(c,req.user,'task_delete',t.id);});change();res.json({ok:true});});
app.get('/api/audit',admin,async(req,res)=>res.json((await pool.query('SELECT * FROM audit ORDER BY id DESC LIMIT 500')).rows));
app.get('/api/export',admin,async(req,res)=>{const wb=new Excel.Workbook(),ws=wb.addWorksheet('Клиенты');ws.columns=[['№','id',10],['Клиент','client_name',25],['Телефон','phone',22],['Адрес','address',40],['Направление','direction',24],['Тип','deal',15],['Ответственный','owner_name',25],['Результат','result',25],['Дата результата','result_date',20],['Создано','created_at',25]].map(([header,key,width])=>({header,key,width}));const labels={rent:'Аренда',selection:'Подбор объекта',sale:'Продать объект',buy:'Купить',sell:'Продать',none:'В работе',success:'Сделка состоялась',failed:'Сделка сорвалась',postponed:'Сделка перенеслась'};for(const t of await tasks(req.user))ws.addRow({...t,direction:labels[t.direction],deal:labels[t.deal],result:labels[t.result],created_at:new Date(t.created_at),result_date:t.result_date?String(t.result_date).slice(0,10):''});ws.getRow(1).font={bold:true};ws.views=[{state:'frozen',ySplit:1}];ws.autoFilter='A1:J1';await audit(pool,req.user,'export');res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="evrika-clients.xlsx"');await wb.xlsx.write(res);res.end();});
app.use('/api',(req,res)=>res.status(404).json({error:'Маршрут не найден'}));app.use(express.static(path.join(__dirname,'..','public')));app.use((e,req,res,next)=>{if(res.headersSent)return next(e);if(!e.status)console.error(e);res.status(e.status|| (e.code==='23505'?409:500)).json({error:e.status?e.message:e.code==='23505'?'Логин уже занят':'Ошибка сервера'});});
io.use(async(socket,next)=>{try{socket.user=await verify(socket.handshake.auth.token);next();}catch(e){next(new Error(e.message));}});io.on('connection',s=>{const uid=String(s.user.id);s.join('user:'+uid);s.join(s.user.role==='admin'?'admins':'employees');if(s.user.role==='employee'){online.set(uid,(online.get(uid)||0)+1);presence();}const check=setInterval(()=>verify(s.handshake.auth.token).catch(()=>s.disconnect(true)),60000);s.on('disconnect',()=>{clearInterval(check);if(s.user.role==='employee'){const n=(online.get(uid)||1)-1;if(n<=0)online.delete(uid);else online.set(uid,n);presence();}});});
(async () => {
  await pool.query('SELECT id FROM users LIMIT 1');
  const { rows: [{ exists }] } = await pool.query(
    "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'tasks'::regclass AND attname = 'property_type' AND NOT attisdropped)"
  );
  if (!exists) {
    await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS property_type text CHECK (property_type IN (' +
      propertyTypes.map(type => "'" + type + "'").join(', ') + '))');
  }
  await migrateMonitor(tx);
  await tx(async client => {
    await client.query('SELECT pg_advisory_xact_lock(74206, 3)');
    await client.query('CREATE INDEX IF NOT EXISTS audit_task_history_idx ON audit(task_id,id) WHERE task_id IS NOT NULL');
  });
  const port = process.env.PORT || 3000;
  const host = process.env.HOST || '0.0.0.0';
  server.listen(Number(port), host, () => {
    console.log(`EVRIKA CRM: ${tls ? 'https' : 'http'}://localhost:${port}`);
    if (!process.env.DATABASE_URL) {
      require('./backup').schedule();
    }
    monitor.start();
    if (process.env.EVRIKA_LAN_DISCOVERY === '1') {
      const { advertise } = require('../shared/discovery');
      const discovery = advertise({ port: server.address().port, secure: !!tls,
        onError: code => console.error('[DISCOVERY]', code) });
      server.once('close', () => { try { discovery.close(); } catch {} });
    }
  });
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
server.once('close', () => { void monitor.stop(); });
if (process.env.EVRIKA_WINDOWS_SERVICE === '1') {
  const input = require('node:readline').createInterface({ input: process.stdin });
  input.once('line', async command => {
    input.close();
    if (command !== 'stop') return;
    await monitor.stop();
    await new Promise(resolve => io.close(resolve));
    await pool.end();
    process.exit(0);
  });
}
