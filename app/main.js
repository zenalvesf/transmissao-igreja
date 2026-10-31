/* Aplicativo de área de trabalho (Electron): roda o servidor por dentro, abre a mesa numa janela
 * própria, fica na bandeja do Windows e pode iniciar junto com o sistema. */
'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const HIDDEN = process.argv.includes('--hidden');
app.setAppUserModelId('br.igreja.transmissao');

// Só uma instância: se abrir de novo, mostra a janela que já existe
if (!app.requestSingleInstanceLock()) { app.quit(); }

// Dados graváveis (config, roteiro, certificados) ficam na pasta do usuário, não na do programa
const userData = app.getPath('userData');
fs.mkdirSync(userData, { recursive: true });
process.env.TI_DATA_DIR = userData;

// Log em arquivo, para dar suporte depois
const LOG = path.join(userData, 'log.txt');
try { if (fs.existsSync(LOG) && fs.statSync(LOG).size > 2e6) fs.unlinkSync(LOG); } catch { /* ignorar */ }
for (const level of ['log', 'error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`); } catch { /* ignorar */ }
  };
}

let server = null;
try {
  server = require('../server.js');
} catch (e) {
  console.error('[app] servidor não iniciou', e);
  app.whenReady().then(() => { dialog.showErrorBox('Transmissão Igreja', 'O servidor não iniciou:\n' + e.message); app.quit(); });
}

const mesaUrl = () => `http://127.0.0.1:${server.config.httpPort}/mesa`;
const homeUrl = () => `http://127.0.0.1:${server.config.httpPort}/`;

let win = null, tray = null;
app.isQuitting = false;

function iconPath(name) { return path.join(__dirname, name); }

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600,
    title: 'Transmissão Igreja',
    icon: iconPath('icon.png'),
    autoHideMenuBar: true,
    show: !HIDDEN,
    backgroundColor: '#0f1419',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL(mesaUrl());
  win.webContents.on('did-fail-load', () => setTimeout(() => { if (win) win.loadURL(mesaUrl()); }, 1000));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (ev, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); ev.preventDefault(); }
    if (input.key === 'F5') { win.reload(); ev.preventDefault(); }
  });
  win.on('close', (ev) => {
    if (app.isQuitting) return;
    ev.preventDefault();
    win.hide();
    if (tray && !app.avisouBandeja) {
      app.avisouBandeja = true;
      tray.displayBalloon({ title: 'Transmissão Igreja', content: 'O programa continua rodando aqui na bandeja. As câmeras e o OBS seguem conectados.', iconType: 'info' });
    }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function loginItem() { return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin; }

function buildTray() {
  const img = nativeImage.createFromPath(iconPath('icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Transmissão Igreja');
  const refresh = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir mesa de produção', click: showWindow },
      { label: 'Página com QR codes dos celulares', click: () => shell.openExternal(homeUrl()) },
      { type: 'separator' },
      { label: 'Abrir OBS', click: () => { try { server.obsLocal.launchObs(); } catch (e) { dialog.showErrorBox('OBS', e.message); } } },
      { label: 'Iniciar junto com o Windows', type: 'checkbox', checked: loginItem(), click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); refresh(); } },
      { type: 'separator' },
      { label: 'Abrir pasta de dados (roteiro, log)', click: () => shell.openPath(userData) },
      { label: `Versão ${app.getVersion()}`, enabled: false },
      { label: 'Sair (desliga câmeras e mesa)', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
  };
  refresh();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function checkUpdates() {
  if (!app.isPackaged) return;
  try {
    const yml = path.join(process.resourcesPath, 'app-update.yml');
    if (!fs.existsSync(yml) || fs.readFileSync(yml, 'utf8').includes('SEU-USUARIO')) return; // ainda sem repositório publicado
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = console;
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', (info) => {
      if (tray) tray.displayBalloon({ title: 'Atualização pronta', content: `A versão ${info.version} será instalada quando você sair do programa.`, iconType: 'info' });
    });
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.warn('[update]', e.message));
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 3600 * 1000);
  } catch (e) { console.warn('[update] indisponível', e.message); }
}

app.on('second-instance', showWindow);
app.on('window-all-closed', () => { /* continua na bandeja */ });
app.on('activate', showWindow);
app.on('before-quit', () => { app.isQuitting = true; });

app.whenReady().then(() => {
  if (!server) return;
  console.log(`[app] versão ${app.getVersion()} dados em ${userData}`);
  buildTray();
  createWindow();
  setTimeout(checkUpdates, 15000);
});
