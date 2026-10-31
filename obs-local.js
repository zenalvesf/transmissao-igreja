/* Integração com o OBS instalado nesta máquina (Windows):
 * - encontra o executável do OBS
 * - lê/escreve a configuração do servidor WebSocket do OBS (senha, porta, habilitado)
 * - descobre se o OBS está aberto e consegue abri-lo
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const QUIET = { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] };
const WS_CONFIG = path.join(process.env.APPDATA || '', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Configuração do obs-websocket como o OBS a guarda. */
function readWebsocketConfig() {
  const c = readJson(WS_CONFIG);
  if (!c) return null;
  return {
    enabled: !!c.server_enabled,
    port: c.server_port || 4455,
    authRequired: c.auth_required !== false,
    password: c.server_password || '',
    firstLoad: c.first_load !== false,
  };
}

/** Senha que o OBS usa, se ele mesmo já gerou uma. */
function detectedPassword() {
  const c = readWebsocketConfig();
  return c && c.password ? c.password : '';
}

/** Deixa o WebSocket habilitado e com senha. Só faz efeito quando o OBS (re)inicia. */
function ensureWebsocketEnabled() {
  const cur = readJson(WS_CONFIG) || {};
  const next = Object.assign({ alerts_enabled: false, auth_required: true, server_port: 4455 }, cur, {
    server_enabled: true,
    first_load: false,
  });
  if (!next.server_password) next.server_password = crypto.randomBytes(12).toString('base64url');
  fs.mkdirSync(path.dirname(WS_CONFIG), { recursive: true });
  fs.writeFileSync(WS_CONFIG, JSON.stringify(next, null, 2));
  return { enabled: true, port: next.server_port, password: next.server_password };
}

function findObsExe() {
  const candidates = [];
  for (const base of [process.env.ProgramFiles, process.env['ProgramW6432'], process.env['ProgramFiles(x86)'], 'C:\\Program Files']) {
    if (base) candidates.push(path.join(base, 'obs-studio', 'bin', '64bit', 'obs64.exe'));
  }
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\OBS Studio', '/ve'], QUIET);
    const m = out.match(/REG_SZ\s+(.+)$/m);
    if (m) candidates.unshift(path.join(m[1].trim(), 'bin', '64bit', 'obs64.exe'));
  } catch { /* chave não existe */ }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function isObsRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq obs64.exe', '/NH'], QUIET);
    return /obs64\.exe/i.test(out);
  } catch { return false; }
}

function launchObs() {
  const exe = findObsExe();
  if (!exe) throw new Error('OBS não encontrado. Instale o OBS Studio em https://obsproject.com');
  if (isObsRunning()) return { started: false, exe };
  // O OBS exige ser iniciado a partir da própria pasta bin/64bit
  const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { started: true, exe };
}

function status() {
  const exe = findObsExe();
  const ws = readWebsocketConfig();
  return {
    installed: !!exe,
    exe,
    running: isObsRunning(),
    websocket: ws ? { enabled: ws.enabled, port: ws.port, hasPassword: !!ws.password, authRequired: ws.authRequired } : null,
  };
}

module.exports = { readWebsocketConfig, detectedPassword, ensureWebsocketEnabled, findObsExe, isObsRunning, launchObs, status, WS_CONFIG };
