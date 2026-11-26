const {
    app,
    BrowserWindow,
    ipcMain,
    Notification,
    globalShortcut,
    dialog
} = require('electron');

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pkg = require('../package.json');

const role = process.argv.includes('--admin')
    ? 'admin'
    : process.argv.includes('--employee')
        ? 'employee'
        : pkg.evrikaRole || 'employee';

app.setName(
    role === 'admin'
        ? 'EVRIKA Admin'
        : 'EVRIKA Employee'
);

app.setAppUserModelId('ru.evrika.crm.' + role);

let win;
let base;
let configPath;

const icon = path.join(__dirname, 'icon.ico');


// ==========================================
// ПРОВЕРКА АДРЕСА СЕРВЕРА
// ==========================================

function validate(raw) {
    try {
        const u = new URL(raw);

        if (
            !['http:', 'https:'].includes(u.protocol) ||
            u.username ||
            u.password ||
            u.pathname !== '/' ||
            u.search ||
            u.hash
        ) {
            return null;
        }

        if (
            role === 'admin' &&
            !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
        ) {
            return null;
        }

        return u.origin;

    } catch {
        return null;
    }
}


// ==========================================
// ПРОВЕРКА РАБОТЫ СЕРВЕРА
// ==========================================

function serverHealthy() {
    return new Promise(resolve => {

        let done = false;

        const finish = value => {
            if (!done) {
                done = true;
                resolve(value);
            }
        };

        try {
            const u = new URL('/api/health', base);

            const protocol = require(
                u.protocol === 'https:' ? 'https' : 'http'
            );

            const req = protocol.get(u, res => {

                let body = '';

                res.setEncoding('utf8');

                res.on('data', data => {
                    body += data;

                    if (body.length > 8192) {
                        res.destroy();
                        finish(false);
                    }
                });

                res.on('end', () => {
                    try {
                        const result = JSON.parse(body);

                        finish(
                            res.statusCode === 200 &&
                            result.ok === true &&
                            result.app === 'EVRIKA CRM' &&
                            result.database === 'PostgreSQL'
                        );

                    } catch {
                        finish(false);
                    }
                });

                res.on('error', () => finish(false));
            });

            req.setTimeout(1200, () => {
                req.destroy();
                finish(false);
            });

            req.on('error', () => finish(false));

        } catch {
            finish(false);
        }
    });
}


// ==========================================
// ПРОВЕРКА ПАПКИ ПРОЕКТА
// ==========================================

function validRoot(root) {

    return typeof root === 'string' && [

        'server/index.js',
        '.env',
        'node_modules/express/package.json',
        'node_modules/pg/package.json'

    ].every(file => {

        return fs.existsSync(
            path.join(root, file)
        );

    });
}


// ==========================================
// ФОНОВЫЙ ЗАПУСК СЕРВЕРА NODE.JS
// ==========================================

async function startLocalServer() {

    if (role !== 'admin') {
        return;
    }

    // Если сервер уже запущен,
    // повторно запускать его не нужно.

    if (await serverHealthy()) {
        return;
    }

    const config = path.join(
        path.dirname(configPath),
        'server-root.json'
    );

    let root;

    try {
        root = JSON.parse(
            fs.readFileSync(config, 'utf8')
        ).root;
    } catch {}


    // При запуске через npm используем
    // текущую папку проекта.

    if (!validRoot(root) && !app.isPackaged) {
        root = path.join(__dirname, '..');
    }


    // При первом запуске установленного EXE
    // предлагаем выбрать папку проекта.

    if (!validRoot(root)) {

        const pick = await dialog.showOpenDialog({

            title: 'Выберите папку проекта EVRIKA-CRM',

            properties: ['openDirectory']

        });

        if (
            pick.canceled ||
            !validRoot(pick.filePaths[0])
        ) {
            throw new Error(
                'Не найдена настроенная папка EVRIKA-CRM. ' +
                'Выберите папку с .env, server и node_modules.'
            );
        }

        root = pick.filePaths[0];
    }


    // Сохраняем путь к проекту.

    fs.mkdirSync(path.dirname(config), {
        recursive: true
    });

    fs.writeFileSync(
        config,
        JSON.stringify({ root })
    );


    // Создаём папку журналов.

    const logDir = path.join(root, 'logs');

    fs.mkdirSync(logDir, {
        recursive: true
    });

    const log = path.join(
        logDir,
        'server-background.log'
    );

    const fd = fs.openSync(log, 'a');

    let child;
    let spawnError;


    // Запускаем сервер в фоне.
    // Окно PowerShell открываться не будет.

    try {

        child = spawn(

            process.env.npm_node_execpath ||
            (
                process.platform === 'win32'
                    ? 'node.exe'
                    : 'node'
            ),

            [
                path.join(
                    root,
                    'server',
                    'index.js'
                )
            ],

            {
                cwd: root,

                detached: true,

                windowsHide: true,

                stdio: [
                    'ignore',
                    fd,
                    fd
                ]
            }
        );

        child.on('error', error => {
            spawnError = error;
        });

        // Сервер продолжит работать
        // после закрытия Electron.

        child.unref();

    } finally {

        fs.closeSync(fd);

    }


    // Ожидаем готовности сервера.

    for (let i = 0; i < 30; i++) {

        if (await serverHealthy()) {
            return;
        }

        if (spawnError) {
            throw new Error(
                'Не удалось запустить Node.js: ' +
                spawnError.message
            );
        }

        if (child.exitCode !== null) {
            break;
        }

        await new Promise(resolve => {
            setTimeout(resolve, 500);
        });
    }

    if (await serverHealthy()) {
        return;
    }

    throw new Error(

        'Сервер не ответил. ' +
        'Проверьте PostgreSQL, .env, ' +
        'адрес сервера и журнал: ' + log

    );
}


// ==========================================
// ЗАГРУЗКА НАСТРОЕК ПОДКЛЮЧЕНИЯ
// ==========================================

function load() {
    try {

        const config = JSON.parse(
            fs.readFileSync(configPath, 'utf8')
        );

        return validate(config.server);

    } catch {

        return null;

    }
}


// ==========================================
// ПРОВЕРКА IPC
// ==========================================

function allowed(event) {

    return !!base &&
        event.sender === win?.webContents &&
        event.senderFrame === win.webContents.mainFrame &&
        new URL(event.senderFrame.url).origin === base;

}


// ==========================================
// СОЗДАНИЕ ОКНА ELECTRON
// ==========================================

function create() {

    win = new BrowserWindow({

        width: 1500,
        height: 950,

        minWidth: 900,
        minHeight: 600,

        fullscreen: true,

        autoHideMenuBar: true,

        icon,

        webPreferences: {

            preload: path.join(
                __dirname,
                'preload.js'
            ),

            contextIsolation: true,

            nodeIntegration: false,

            sandbox: true

        }

    });


    win.webContents.setWindowOpenHandler(() => ({
        action: 'deny'
    }));


    win.webContents.on(
        'will-navigate',
        (event, url) => {

            if (
                !base ||
                new URL(url).origin !== base
            ) {
                event.preventDefault();
            }

        }
    );


    win.webContents.on(
        'did-fail-load',
        (_, code, description, url, main) => {

            if (main && code !== -3) {
                showConfig();
            }

        }
    );


    win.webContents.session.setPermissionRequestHandler(

        (_, permission, callback) => {
            callback(false);
        }

    );


    win.on('closed', () => {
        win = null;
    });


    if (base) {

        open();

    } else {

        showConfig();

    }

}


// ==========================================
// ОТКРЫТИЕ CRM
// ==========================================

function open() {

    win.loadURL(
        base + '/?role=' + role
    ).catch(() => {});

}


// ==========================================
// НАСТРОЙКИ ПОДКЛЮЧЕНИЯ
// ==========================================

function showConfig() {

    if (win && !win.isDestroyed()) {

        win.loadFile(

            path.join(
                __dirname,
                'connect.html'
            ),

            {
                query: {

                    role,

                    server:
                        base ||
                        'http://127.0.0.1:3000'

                }
            }

        ).catch(() => {});

    }

}


// ==========================================
// ЗАПУСК ПРИЛОЖЕНИЯ
// ==========================================

app.whenReady().then(async () => {

    app.setPath(

        'userData',

        path.join(
            app.getPath('appData'),
            'EVRIKA-' + role
        )

    );


    configPath = path.join(

        app.getPath('userData'),

        'connection.json'

    );


    base = load() || (

        role === 'admin'
            ? 'http://127.0.0.1:3000'
            : null

    );


// ==========================================
// ПОДКЛЮЧЕНИЕ К СЕРВЕРУ
// ==========================================

    ipcMain.handle(

        'evrika:connect',

        async (event, raw) => {

            if (

                event.sender !== win?.webContents ||

                event.senderFrame !==
                    win.webContents.mainFrame ||

                !event.senderFrame.url.startsWith('file:')

            ) {

                throw new Error('Недоступно');

            }

            const valid = validate(raw);

            if (!valid) {

                throw new Error(
                    'Введите корректный адрес сервера'
                );

            }

            base = valid;

            fs.mkdirSync(
                path.dirname(configPath),
                { recursive: true }
            );

            fs.writeFileSync(

                configPath,

                JSON.stringify({
                    server: base
                })

            );

            if (role === 'admin') {

                try {

                    await startLocalServer();

                } catch (error) {

                    throw new Error(error.message);

                }

            }

            setImmediate(open);

            return true;

        }

    );


// ==========================================
// УПРАВЛЕНИЕ ОКНОМ И УВЕДОМЛЕНИЯ
// ==========================================

    const handlers = {

        fullscreen: () => {

            win.setFullScreen(
                !win.isFullScreen()
            );

        },

        minimize: () => {

            win.minimize();

        },

        configure: showConfig,

        notify: () => {

            if (Notification.isSupported()) {

                new Notification({

                    title: 'EVRIKA CRM',

                    body: 'Получена новая задача',

                    icon,

                    silent: true

                }).show();

            }

        }

    };


    for (const [name, handler] of Object.entries(handlers)) {

        ipcMain.handle(

            'evrika:' + name,

            event => {

                if (!allowed(event)) {

                    throw new Error('Недоступно');

                }

                return handler();

            }

        );

    }


// ==========================================
// АВТОМАТИЧЕСКИЙ ЗАПУСК СЕРВЕРА
// ==========================================

    if (role === 'admin') {

        try {

            await startLocalServer();

        } catch (error) {

            dialog.showErrorBox(

                'EVRIKA — запуск сервера',

                error.message

            );

        }

    }


// ==========================================
// ОТКРЫВАЕМ ОКНО ПРИЛОЖЕНИЯ
// ==========================================

    create();


    globalShortcut.register('F11', () => {

        win?.setFullScreen(
            !win.isFullScreen()
        );

    });


    globalShortcut.register('Escape', () => {

        if (win?.isFullScreen()) {

            win.setFullScreen(false);

        }

    });


    app.on('activate', () => {

        if (!win) {

            create();

        }

    });

});


// ==========================================
// ЗАКРЫТИЕ ПРИЛОЖЕНИЯ
// ==========================================

app.on('will-quit', () => {

    globalShortcut.unregisterAll();

});


app.on('window-all-closed', () => {

    app.quit();

});