'use strict';
/*
 * RuiC-2D 桌面版主进程
 * - 启动本地 HTTP 服务（复用仓库内 server.mjs），无需用户安装 Node
 * - 工作台窗口 + 直播挂件窗口（透明/无边框/置顶/鼠标穿透）
 * - 控制台、托盘、全局快捷键、OBS 地址复制
 * - 数据目录与示例角色首次运行自动准备
 */
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, session, shell,
  clipboard, nativeImage, screen, powerSaveBlocker,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const {fork} = require('node:child_process');

const APP_ROOT = app.getAppPath();
const PANEL_HTML = path.join(__dirname, 'panel.html');
const PRELOAD = path.join(__dirname, 'preload.cjs');
const LOGO = path.join(__dirname, 'build', 'icon.png');

app.setName('RuiC-2D');
app.setAppUserModelId('com.ruic.ruic2d');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 配置 */

const CONFIG_PATH = path.join(app.getPath('userData'), 'desktop.json');
let cfg = {
  port: 8796,
  overlay: {project: 'da-fei-yu-1', bg: 'transparent', pinned: true, clickThrough: false, size: 540, bounds: null},
  win: null,
  stayAwake: false,
};
try {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg = {...cfg, ...raw, overlay: {...cfg.overlay, ...(raw.overlay || {})}};
} catch {}
function saveCfg() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), {recursive: true});
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) { log('saveCfg: ' + e.message); }
}

/* -------------------------------------------------------------- 数据目录 */

function resolveDataDir() {
  if (process.env.YOUXING_DATA) return path.resolve(process.env.YOUXING_DATA);
  const exeDir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(exeDir, 'portable.txt')) || fs.existsSync(path.join(exeDir, 'data'))) {
    return path.join(exeDir, 'data');
  }
  return path.join(app.getPath('userData'), 'data');
}
const DATA = resolveDataDir();
fs.mkdirSync(DATA, {recursive: true});
fs.mkdirSync(path.join(DATA, 'projects'), {recursive: true});
fs.mkdirSync(path.join(DATA, 'exports'), {recursive: true});
fs.mkdirSync(path.join(DATA, 'logs'), {recursive: true});

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(path.join(DATA, 'logs', 'desktop.log'), line); } catch {}
  if (!app.isPackaged) process.stdout.write(line);
}

/* ------------------------------------------------- 运行时组件（Python 等） */

function findInPath(names) {
  const parts = String(process.env.PATH || '').split(path.delimiter);
  for (const name of names) {
    for (const dir of parts) {
      if (!dir) continue;
      const clean = dir.replace(/^"|"$/g, '');
      try {
        const p = path.join(clean, name);
        if (fs.existsSync(p)) return p;
      } catch {}
    }
  }
  return null;
}

const pythonCandidates = [
  process.env.YOUXING_PYTHON,
  path.join(APP_ROOT, 'runtime', 'python', 'python.exe'),
  path.join(APP_ROOT, '_build', 'python', 'python.exe'),
];
let pythonPath = pythonCandidates.find((p) => p && fs.existsSync(p)) || findInPath(['python.exe', 'python3.exe']) || '';

const ffmpegCandidates = [
  process.env.YOUXING_FFMPEG,
  path.join(APP_ROOT, 'bin', 'ffmpeg.exe'),
];
let ffmpegPath = ffmpegCandidates.find((p) => p && fs.existsSync(p)) || findInPath(['ffmpeg.exe']) || '';

const pythonInfo = pythonPath
  ? {ok: true, label: pythonPath.includes(path.join(APP_ROOT, 'runtime')) ? '自带运行时' : '本机 Python', path: pythonPath}
  : {ok: false, label: '未找到 Python（无法从新图制作）', path: ''};
const ffmpegInfo = ffmpegPath
  ? {ok: true, label: '已就绪', path: ffmpegPath}
  : {ok: false, label: '未找到 FFmpeg（无法导入配音文件）', path: ''};

/* -------------------------------------------------------------- 本地服务 */

let child = null;
let crashTimes = [];
let PORT = cfg.port || 8796;
let serverReady = false;
let startupError = '';
let quitting = false;

const serverUrl = () => `http://127.0.0.1:${PORT}`;
/* editor=1 直接进入编辑器，跳过首页案例库 */
const appPageUrl = () => serverUrl() + '/?project=' + encodeURIComponent(cfg.overlay.project || 'da-fei-yu-1') + '&editor=1';

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}
async function pickPort() {
  for (let p = cfg.port || 8796; p < (cfg.port || 8796) + 25; p++) {
    if (await portFree(p)) return p;
  }
  return cfg.port || 8796;
}

function ensureData() {
  const marker = path.join(DATA, 'projects', '.seeded');
  if (fs.existsSync(marker)) return;
  const src = path.join(APP_ROOT, 'projects');
  if (!fs.existsSync(src)) return;
  try {
    for (const entry of fs.readdirSync(src, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const from = path.join(src, entry.name);
      const to = path.join(DATA, 'projects', entry.name);
      if (fs.existsSync(to)) continue;
      log('准备示例角色:', entry.name);
      fs.cpSync(from, to, {recursive: true});
    }
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (e) {
    log('ensureData 失败:', e.message);
  }
}

function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({host: '127.0.0.1', port: PORT, path: '/api/projects', timeout: 2000}, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('本地服务启动超时'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function startServer() {
  if (child) { try { child.kill(); } catch {} child = null; }
  serverReady = false;
  PORT = await pickPort();
  cfg.port = PORT;
  saveCfg();
  ensureData();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    YOUXING_PORT: String(PORT),
    YOUXING_DATA: DATA,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  if (pythonPath) env.YOUXING_PYTHON = pythonPath;
  if (ffmpegPath) env.YOUXING_FFMPEG = ffmpegPath;
  log('启动服务', PORT, 'data=', DATA, 'python=', pythonPath || '(未找到)', 'ffmpeg=', ffmpegPath || '(未找到)');
  child = fork(path.join(APP_ROOT, 'server.mjs'), [], {
    env,
    cwd: APP_ROOT,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const thisChild = child;
  const logFile = path.join(DATA, 'logs', 'server.log');
  const write = (chunk) => { try { fs.appendFileSync(logFile, chunk); } catch {} };
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  child.on('exit', (code) => {
    log('服务退出 code=', code);
    if (quitting) return;
    serverReady = false;
    broadcast();
    if (child !== thisChild) return; /* 主动重启导致的退出，忽略 */
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < 300000);
    if (crashTimes.length >= 3) { log('服务连续崩溃，停止自动重启'); return; }
    crashTimes.push(now);
    setTimeout(() => {
      if (!quitting) startServer().catch((e) => log('自动重启失败: ' + e.message));
    }, 1500);
  });
  try {
    await waitForServer(45000);
    serverReady = true;
    startupError = '';
  } catch (e) {
    serverReady = false;
    startupError = e.message;
    broadcast();
    throw e;
  }
  broadcast();
}

/* ---------------------------------------------------------------- 窗口 */

let panelWin = null;
let micWasOn = false;
let appWin = null;
let overlay = null;
let tray = null;
let powerId = null;

const BG_COLOR = {transparent: '#00000000', green: '#00b140', dark: '#151b27', white: '#f1f2f5'};

function icon() {
  if (fs.existsSync(LOGO)) return nativeImage.createFromPath(LOGO);
  return nativeImage.createEmpty();
}

function createPanel() {
  if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); return panelWin; }
  panelWin = new BrowserWindow({
    width: 418, height: 884, minWidth: 380, minHeight: 560,
    title: 'RuiC-2D 控制台',
    backgroundColor: '#11141b',
    icon: icon(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {preload: PRELOAD, contextIsolation: true, nodeIntegration: false},
  });
  panelWin.loadFile(PANEL_HTML);
  panelWin.once('ready-to-show', () => panelWin.show());
  panelWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    panelWin.hide();
    notify('RuiC-2D 仍在后台运行', '它还在托盘里；需要重新打开请双击托盘图标或按 Ctrl+Alt+P。');
  });
  panelWin.webContents.setWindowOpenHandler(({url}) => {
    if (/^https?:/i.test(url)) { shell.openExternal(url); return {action: 'deny'}; }
    return {action: 'deny'};
  });
  return panelWin;
}

function notify(title, body) {
  try { new (require('electron').Notification)({title, body, icon: icon()}).show(); } catch {}
}

async function openApp(mode) {
  if (appWin && !appWin.isDestroyed()) {
    appWin.show(); appWin.focus();
    if (mode) runInApp(mode);
    return appWin;
  }
  if (!serverReady) await startServer().catch(() => {});
  const bounds = cfg.win || {};
  appWin = new BrowserWindow({
    width: bounds.width || 1480,
    height: bounds.height || 940,
    x: bounds.x, y: bounds.y,
    minWidth: 1080, minHeight: 700,
    title: 'RuiC-2D 工作台',
    backgroundColor: '#151922',
    icon: icon(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false},
  });
  appWin.loadURL(appPageUrl());
  appWin.once('ready-to-show', () => appWin.show());
  appWin.on('close', () => {
    if (appWin) {
      const b = appWin.getBounds();
      cfg.win = b;
      saveCfg();
    }
  });
  appWin.on('closed', () => { appWin = null; broadcast(); });
  appWin.on('page-title-updated', (e) => {
    e.preventDefault();
    if (appWin && !appWin.isDestroyed()) appWin.setTitle('RuiC-2D 工作台');
  });
  appWin.webContents.setWindowOpenHandler(({url}) => {
    if (url.includes('/player.html')) { openOverlayFromUrl(url); return {action: 'deny'}; }
    if (url.startsWith(serverUrl())) {
      return {action: 'allow', overrideBrowserWindowOptions: {width: 1200, height: 860, backgroundColor: '#151922', autoHideMenuBar: true}};
    }
    if (/^https?:/i.test(url)) { shell.openExternal(url); return {action: 'deny'}; }
    return {action: 'deny'};
  });
  appWin.webContents.on('did-finish-load', () => {
    if (appWin && !appWin.isDestroyed()) appWin.setTitle('RuiC-2D 工作台');
    syncAppProject();
    if (mode) setTimeout(() => runInApp(mode), 400);
  });
  return appWin;
}

/* 工作台切换形象时，通知挂件跟随 */
async function syncAppProject() {
  if (!appWin || appWin.isDestroyed()) return;
  try {
    await appWin.webContents.executeJavaScript(`(()=>{
      const sel=document.querySelector('#project-select');
      if(!sel||sel.dataset.ruicSync)return false;
      sel.dataset.ruicSync='1';
      sel.addEventListener('change',()=>{try{window.ruic&&window.ruic.projectChanged(sel.value)}catch(e){}});
      return true;
    })()`);
  } catch (e) { log('注入形象切换监听失败: ' + e.message); }
}



async function runInApp(mode) {
  if (!appWin || appWin.isDestroyed()) return;
  const js = {
    live: `(()=>{const b=document.querySelector('[data-mode="live"]');if(b)b.click();return !!b})()`,
    import: `(()=>{const b=document.querySelector('#choose-image');if(b)b.click();return !!b})()`,
    home: `(()=>{location.hash='';document.querySelector('#home')?.scrollIntoView();return true})()`,
  }[mode];
  if (!js) return;
  try { await appWin.webContents.executeJavaScript(js); } catch (e) { log('runInApp ' + mode + ': ' + e.message); }
}

async function startLive() {
  await openApp('live');
  await sleep(900);
  /* 打开麦克风（若还没开） */
  for (let i = 0; i < 5; i++) {
    let r = 'none';
    try {
      r = await appWin.webContents.executeJavaScript(
        `(()=>{const b=document.querySelector('#toggle-mic');if(!b)return 'none';if(/开启麦克风|开启/.test(b.textContent)){b.click();return 'clicked'}return 'already'})()`
      );
    } catch {}
    if (r !== 'none') break;
    await sleep(500);
  }
  const project = await currentProject();
  if (project) { cfg.overlay.project = project; saveCfg(); }
  showOverlay();
  return state();
}

async function currentProject() {
  if (!appWin || appWin.isDestroyed()) return '';
  try {
    return await appWin.webContents.executeJavaScript(
      `(()=>{const s=document.querySelector('#project-select');return (s&&s.value)||''})()`
    );
  } catch { return ''; }
}

/* 切换形象后重新打开麦克风，直播不中断 */
async function enableMic() {
  if (!appWin || appWin.isDestroyed()) return 'none';
  try {
    return await appWin.webContents.executeJavaScript(
      `(()=>{const b=document.querySelector('#toggle-mic');if(!b)return 'none';if(b.textContent.includes('关闭'))return 'already';b.click();return 'clicked'})()`
    );
  } catch { return 'none'; }
}

async function keepMicOnAfterSwitch() {
  let stable = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(800);
    const r = await enableMic();
    if (r === 'clicked') { log('切换形象后已重新打开麦克风'); stable = 0; continue; }
    if (r === 'already') { stable += 1; if (stable >= 3) return; }
    else stable = 0;
  }
}
function switchOverlayProject(id, keepMic) {
  if (!id || id === cfg.overlay.project) return false;
  log('切换挂件形象 -> ' + id + ' keepMic=' + keepMic);
  cfg.overlay.project = id;
  saveCfg();
  overlayReload();
  broadcast();
  if (keepMic) keepMicOnAfterSwitch();
  return true;
}

/* ------------------------------------------------------------ 直播挂件 */

function overlayUrl() {
  return serverUrl() + '/player.html?project=' + encodeURIComponent(cfg.overlay.project) + '&bg=' + encodeURIComponent(cfg.overlay.bg);
}

function applyOverlayFlags() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setAlwaysOnTop(!!cfg.overlay.pinned, 'screen-saver');
  overlay.setIgnoreMouseEvents(!!cfg.overlay.clickThrough, {forward: true});
  overlay.webContents.insertCSS(
    cfg.overlay.clickThrough
      ? 'html,body{-webkit-app-region:no-drag !important;pointer-events:none}'
      : 'html,body{-webkit-app-region:drag;user-select:none;cursor:move}'
  ).catch(() => {});
}

function showOverlay() {
  if (overlay && !overlay.isDestroyed()) {
    overlay.showInactive();
    applyOverlayFlags();
    broadcast();
    return overlay;
  }
  const size = cfg.overlay.size || 540;
  const area = screen.getPrimaryDisplay().workArea;
  const b = cfg.overlay.bounds || {width: size, height: size, x: area.x + area.width - size - 32, y: area.y + area.height - size - 32};
  overlay = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    title: 'RuiC-2D 挂件',
    backgroundColor: '#00000000',
    icon: icon(),
    fullscreenable: true,
    webPreferences: {preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false},
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.loadURL(overlayUrl());
  overlay.once('ready-to-show', () => overlay.showInactive());
  overlay.on('page-title-updated', (e) => { e.preventDefault(); overlay.setTitle('RuiC-2D 挂件'); });
  overlay.webContents.on('did-finish-load', applyOverlayFlags);
  let saveTimer = null;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!overlay || overlay.isDestroyed()) return;
      cfg.overlay.bounds = overlay.getBounds();
      saveCfg();
      broadcast();
    }, 350);
  };
  overlay.on('moved', remember);
  overlay.on('resized', remember);
  overlay.on('closed', () => { overlay = null; broadcast(); });
  broadcast();
  return overlay;
}

function hideOverlay() {
  if (overlay && !overlay.isDestroyed()) overlay.hide();
  broadcast();
}

function destroyOverlay() {
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  overlay = null;
  broadcast();
}

function overlayReload() {
  if (!overlay || overlay.isDestroyed()) { showOverlay(); return; }
  overlay.loadURL(overlayUrl());
}

function openOverlayFromUrl(url) {
  try {
    const u = new URL(url);
    const p = u.searchParams.get('project');
    const bg = u.searchParams.get('bg');
    if (p) cfg.overlay.project = p;
    if (bg) cfg.overlay.bg = ['transparent', 'green', 'dark', 'white'].includes(bg) ? bg : 'transparent';
    saveCfg();
  } catch {}
  showOverlay();
  overlayReload();
}

function setOverlaySize(size) {
  cfg.overlay.size = size;
  saveCfg();
  if (overlay && !overlay.isDestroyed()) {
    const b = overlay.getBounds();
    const area = screen.getPrimaryDisplay().workArea;
    const w = Math.min(size, area.width), h = Math.min(size, area.height);
    overlay.setBounds({width: w, height: h, x: Math.min(b.x, area.x + area.width - w), y: Math.min(b.y, area.y + area.height - h)});
  } else {
    cfg.overlay.bounds = null;
  }
  broadcast();
}

/* ------------------------------------------------------------ 状态同步 */

function state() {
  return {
    ready: serverReady,
    error: startupError,
    port: PORT,
    url: serverUrl(),
    project: cfg.overlay.project,
    obsUrl: overlayUrl(),
    biliUrl: overlayUrl(),
    dataDir: DATA,
    overlay: {
      open: !!(overlay && !overlay.isDestroyed() && overlay.isVisible()),
      bg: cfg.overlay.bg,
      pinned: !!cfg.overlay.pinned,
      clickThrough: !!cfg.overlay.clickThrough,
      size: cfg.overlay.size,
    },
    python: pythonInfo,
    ffmpeg: ffmpegInfo,
    stayAwake: powerId !== null,
    appOpen: !!(appWin && !appWin.isDestroyed()),
    version: app.getVersion(),
  };
}

async function probeState() {
  const probe = {};
  if (overlay && !overlay.isDestroyed()) {
    probe.overlay = await overlay.webContents.executeJavaScript(
      `({age: Math.round(window.__player?.signalAge ?? -1), remote: !!window.__player?.remote, project: new URLSearchParams(location.search).get('project'), visible: document.visibilityState})`
    ).catch((e) => ({error: e.message}));
  }
  if (appWin && !appWin.isDestroyed()) {
    probe.app = await appWin.webContents.executeJavaScript(
      `({project: document.querySelector('#project-select')?.value || '', mode: document.querySelector('[data-mode="live"].active') ? 'live' : 'other', mic: !!document.querySelector('#toggle-mic')?.textContent?.includes('关闭')})`
    ).catch((e) => ({error: e.message}));
  }
  probe.cfg = {project: cfg.overlay.project, bg: cfg.overlay.bg};
  return probe;
}

function broadcast() {
  const s = state();
  for (const w of [panelWin, appWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('ruic:state', s);
  }
  updateTray();
}

/* ---------------------------------------------------------------- 托盘 */

function updateTray() {
  if (!tray) return;
  const s = state();
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: 'RuiC-2D ' + (s.ready ? '已就绪' : '启动中…'), enabled: false},
    {type: 'separator'},
    {label: '打开控制台', click: () => createPanel()},
    {label: '打开工作台', click: () => openApp()},
    {label: s.overlay.open ? '隐藏直播挂件' : '显示直播挂件', click: () => (s.overlay.open ? hideOverlay() : showOverlay())},
    {type: 'separator'},
    {label: '挂件置顶', type: 'checkbox', checked: s.overlay.pinned, click: (item) => { cfg.overlay.pinned = item.checked; saveCfg(); applyOverlayFlags(); broadcast(); }},
    {label: '挂件鼠标穿透（锁定）', type: 'checkbox', checked: s.overlay.clickThrough, click: (item) => { cfg.overlay.clickThrough = item.checked; saveCfg(); applyOverlayFlags(); broadcast(); }},
    {label: '挂件背景', submenu: [
      {label: '透明（OBS 窗口采集）', type: 'radio', checked: s.overlay.bg === 'transparent', click: () => setOverlayBg('transparent')},
      {label: '绿幕（色键抠像）', type: 'radio', checked: s.overlay.bg === 'green', click: () => setOverlayBg('green')},
      {label: '深色', type: 'radio', checked: s.overlay.bg === 'dark', click: () => setOverlayBg('dark')},
    ]},
    {label: '复制直播姬 / OBS 地址', click: () => copyObs()},
    {type: 'separator'},
    {label: '数据文件夹', click: () => shell.openPath(DATA)},
    {label: '重启本地服务', click: () => restartServer()},
    {label: '退出', click: () => quitApp()},
  ]));
  tray.setToolTip('RuiC-2D 直播工作台');
}

function setOverlayBg(bg) {
  cfg.overlay.bg = bg;
  saveCfg();
  overlayReload();
  broadcast();
}

function copyObs() {
  clipboard.writeText(overlayUrl());
  notify('已复制 OBS 地址', overlayUrl());
  return overlayUrl();
}

async function restartServer() {
  log('重启服务');
  try {
    await startServer();
    if (appWin && !appWin.isDestroyed()) appWin.loadURL(appPageUrl());
    if (overlay && !overlay.isDestroyed()) overlayReload();
    notify('本地服务已重启', serverUrl());
  } catch (e) {
    notify('重启失败', e.message);
  }
  broadcast();
}

function togglePower() {
  if (powerId !== null) {
    powerSaveBlocker.stop(powerId);
    powerId = null;
  } else {
    powerId = powerSaveBlocker.start('prevent-display-sleep');
  }
  cfg.stayAwake = powerId !== null;
  saveCfg();
  broadcast();
}

function quitApp() {
  quitting = true;
  try { if (child) child.kill(); } catch {}
  app.quit();
}

/* ----------------------------------------------------------- 全局快捷键 */

function registerShortcuts() {
  const map = {
    'Control+Alt+H': () => (panelWin && panelWin.isVisible() ? panelWin.hide() : createPanel()),
    'Control+Alt+P': () => (overlay && !overlay.isDestroyed() && overlay.isVisible() ? hideOverlay() : showOverlay()),
    'Control+Alt+W': () => openApp(),
    'Control+Alt+T': () => { cfg.overlay.pinned = !cfg.overlay.pinned; saveCfg(); applyOverlayFlags(); broadcast(); },
    'Control+Alt+G': () => { cfg.overlay.clickThrough = !cfg.overlay.clickThrough; saveCfg(); applyOverlayFlags(); broadcast(); },
    'Control+Alt+F': () => {
      if (!overlay || overlay.isDestroyed()) return;
      const fs2 = !overlay.isFullScreen();
      overlay.setFullScreen(fs2);
    },
    'Control+Alt+B': () => {
      const order = ['transparent', 'green', 'dark'];
      setOverlayBg(order[(order.indexOf(cfg.overlay.bg) + 1) % order.length]);
    },
    'Control+Alt+1': () => setOverlaySize(540),
    'Control+Alt+2': () => setOverlaySize(720),
    'Control+Alt+3': () => setOverlaySize(1080),
  };
  for (const [accel, fn] of Object.entries(map)) {
    try { globalShortcut.register(accel, fn); } catch (e) { log('快捷键注册失败 ' + accel + ': ' + e.message); }
  }
}

/* ------------------------------------------------------------------ IPC */

ipcMain.handle('ruic:state', () => state());

ipcMain.handle('ruic:action', async (_e, name, arg) => {
  try {
    switch (name) {
      case 'panel:show': createPanel(); break;
      case 'app:open': await openApp(arg || ''); break;
      case 'app:live': await startLive(); break;
      case 'app:import': await openApp('import'); break;
      case 'app:home': await openApp('home'); break;
      case 'overlay:show': showOverlay(); break;
      case 'overlay:hide': hideOverlay(); break;
      case 'overlay:toggle': state().overlay.open ? hideOverlay() : showOverlay(); break;
      case 'overlay:bg': setOverlayBg(arg); break;
      case 'overlay:size': setOverlaySize(Number(arg) || 540); break;
      case 'overlay:pin': cfg.overlay.pinned = !cfg.overlay.pinned; saveCfg(); applyOverlayFlags(); break;
      case 'overlay:lock': cfg.overlay.clickThrough = !cfg.overlay.clickThrough; saveCfg(); applyOverlayFlags(); break;
      case 'overlay:fullscreen': {
        if (overlay && !overlay.isDestroyed()) overlay.setFullScreen(!overlay.isFullScreen());
        break;
      }
      case 'overlay:project': {
        if (arg) { cfg.overlay.project = String(arg); saveCfg(); overlayReload(); }
        break;
      }
      case 'obs:copy': return {url: copyObs()};
      case 'plat:copy': { const url = overlayUrl(); clipboard.writeText(url); return {ok: true, url, state: state()}; }
      case 'plat:prepare': {
        setOverlaySize(1080);
        showOverlay();
        const url = overlayUrl();
        clipboard.writeText(url);
        return {ok: true, url, state: state()};
      }
      case 'data:open': shell.openPath(DATA); break;
      case 'logs:open': shell.openPath(path.join(DATA, 'logs')); break;
      case 'server:restart': await restartServer(); break;
      case 'power:toggle': togglePower(); break;
      case 'app:devtools': if (appWin && !appWin.isDestroyed()) appWin.webContents.openDevTools({mode: 'detach'}); break;
      /* 调试辅助 */
      case 'debug:probe': return probeState();
      case 'debug:switch': {
        if (appWin && !appWin.isDestroyed()) {
          await appWin.webContents.executeJavaScript(
            `(()=>{const s=document.querySelector('#project-select');if(!s)return false;s.value=${JSON.stringify(String(arg))};s.dispatchEvent(new Event('change'));return true})()`
          );
        }
        break;
      }
      case 'quit': quitApp(); break;
      default: log('未知操作 ' + name);
    }
    broadcast();
    return {ok: true, state: state()};
  } catch (e) {
    log('action ' + name + ' 失败: ' + e.message);
    return {ok: false, error: e.message, state: state()};
  }
});

/* 工作台里切换形象时，让挂件跟着换 */
ipcMain.on('ruic:project', (_e, id) => {
  switchOverlayProject(String(id || ''), micWasOn);
});

/* ------------------------------------------------------------- 生命周期 */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { createPanel(); });

  app.whenReady().then(async () => {
    /* 摄像头 / 麦克风：仅对本机工作台自动放行 */
    const ses = session.defaultSession;
    const allowFor = (url) => /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url || '');
    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
      const ok = allowFor(details?.requestingUrl || wc?.getURL?.());
      cb(ok && ['media', 'audioCapture', 'videoCapture', 'clipboard-read', 'clipboard-sanitized-write', 'display-capture'].includes(permission));
    });
    ses.setPermissionCheckHandler((_wc, permission, originUrl, details) => {
      const url = details?.requestingUrl || originUrl || '';
      return allowFor(url) && ['media', 'audioCapture', 'videoCapture', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission);
    });

    Menu.setApplicationMenu(null);
    createPanel();

    try {
      tray = new Tray(icon().resize({width: 20, height: 20}));
      tray.setToolTip('RuiC-2D 直播工作台');
      tray.on('double-click', () => createPanel());
      tray.on('click', () => createPanel());
      updateTray();
    } catch (e) { log('托盘创建失败: ' + e.message); }

    registerShortcuts();
    if (cfg.stayAwake) powerId = powerSaveBlocker.start('prevent-display-sleep');
    broadcast();

    try {
      await startServer();
    } catch (e) {
      log('服务启动失败: ' + e.message);
    }
    broadcast();

    /* 调试用：YOUXING_TEST_OPEN=app|live|import 启动后直接打开对应界面 */
    const testOpen = process.env.YOUXING_TEST_OPEN;
    if (testOpen && serverReady) {
      await sleep(600);
      if (testOpen === 'live') await startLive();
      else await openApp(testOpen === 'app' ? '' : testOpen);
    }
    if (process.env.YOUXING_TEST_SWITCH) {
      setTimeout(() => {
        if (appWin && !appWin.isDestroyed()) {
          appWin.webContents.executeJavaScript(
            `(()=>{const s=document.querySelector('#project-select');if(!s)return; s.value=${JSON.stringify(process.env.YOUXING_TEST_SWITCH)}; s.dispatchEvent(new Event('change'));})()`
          ).catch(() => {});
        }
      }, 12000);
    }

    /* 挂件跟随工作台切换的形象；切换后保留麦克风状态 */
    setInterval(async () => {
      if (!serverReady || !appWin || appWin.isDestroyed() || !overlay || overlay.isDestroyed()) return;
      let st = null;
      try {
        st = await appWin.webContents.executeJavaScript(
          `(()=>{const s=document.querySelector('#project-select');const m=document.querySelector('#toggle-mic');return {project:(s&&s.value)||'', mic: !!(m&&m.textContent.includes('关闭'))}})()`
        );
      } catch { return; }
      if (!st) return;
      if (st.project && st.project !== cfg.overlay.project) switchOverlayProject(st.project, micWasOn);
      micWasOn = st.mic;
    }, 2500);

    if (process.env.YOUXING_PROBE === '1') {
      setInterval(async () => {
        try {
          const p = await probeState();
          fs.appendFileSync(path.join(DATA, 'logs', 'probe.log'), JSON.stringify({t: Date.now(), ...p}) + '\n');
        } catch (e) { log('probe: ' + e.message); }
      }, 3000);
    }
  });

  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    try { if (child) child.kill(); } catch {}
  });
}
