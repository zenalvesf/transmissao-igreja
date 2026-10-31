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

// ---- Perfil do OBS (basic.ini): ativar o buffer de replay
const OBS_DIR = path.join(process.env.APPDATA || '', 'obs-studio');

/** Lê um .ini simples em { secoes: [{ nome, linhas }], eol, bom } preservando tudo o que não for alterado. */
function parseIni(text) {
  const bom = text.charCodeAt(0) === 0xFEFF; if (bom) text = text.slice(1);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const secoes = [{ nome: '', linhas: [] }];
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(/^\s*\[([^\]]+)\]\s*$/);
    if (m) secoes.push({ nome: m[1], linhas: [] }); else secoes[secoes.length - 1].linhas.push(l);
  }
  return { secoes, eol, bom };
}
function iniGet(ini, secao, chave) {
  const sec = ini.secoes.find((x) => x.nome === secao); if (!sec) return undefined;
  for (const l of sec.linhas) { const m = l.match(/^\s*([^=;#]+?)\s*=(.*)$/); if (m && m[1] === chave) return m[2].trim(); }
  return undefined;
}
function iniSet(ini, secao, chave, valor) {
  let sec = ini.secoes.find((x) => x.nome === secao);
  if (!sec) { sec = { nome: secao, linhas: [] }; ini.secoes.push(sec); }
  const i = sec.linhas.findIndex((l) => { const m = l.match(/^\s*([^=;#]+?)\s*=/); return m && m[1] === chave; });
  if (i >= 0) sec.linhas[i] = chave + '=' + valor;
  else { let j = sec.linhas.length; while (j > 0 && sec.linhas[j - 1].trim() === '') j--; sec.linhas.splice(j, 0, chave + '=' + valor); }
}
function iniToString(ini) {
  const out = [];
  for (const sec of ini.secoes) { if (sec.nome) out.push('[' + sec.nome + ']'); out.push(...sec.linhas); }
  return (ini.bom ? '\uFEFF' : '') + out.join(ini.eol);
}

/** Pasta do perfil em uso (OBS 31 guarda a escolha em user.ini; versões antigas em global.ini). */
function profileDir() {
  let dir = 'Untitled';
  for (const f of ['user.ini', 'global.ini']) {
    try { const v = iniGet(parseIni(fs.readFileSync(path.join(OBS_DIR, f), 'utf8')), 'Basic', 'ProfileDir'); if (v) { dir = v; break; } } catch { /* sem arquivo */ }
  }
  return path.join(OBS_DIR, 'basic', 'profiles', dir);
}

/** Estado do buffer de replay no perfil do OBS: { configurado, ativado, segundos, modo } ou null. */
function readReplaySettings() {
  const file = path.join(profileDir(), 'basic.ini');
  let ini; try { ini = parseIni(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const modo = (iniGet(ini, 'Output', 'Mode') || 'Simple');
  const sec = /advanced/i.test(modo) ? 'AdvOut' : 'SimpleOutput';
  return { file, modo: sec, ativado: /^true$/i.test(iniGet(ini, sec, 'RecRB') || ''), segundos: Number(iniGet(ini, sec, 'RecRBTime')) || 0 };
}

/** Liga o buffer de replay no perfil do OBS (com N segundos). Só faz efeito com o OBS fechado, pois ele regrava o basic.ini ao sair. */
function enableReplayBuffer(segundos) {
  if (isObsRunning()) throw new Error('Feche o OBS primeiro: ele regrava as configurações ao fechar.');
  const file = path.join(profileDir(), 'basic.ini');
  let ini; try { ini = parseIni(fs.readFileSync(file, 'utf8')); } catch { ini = parseIni(''); }
  const sec = /advanced/i.test(iniGet(ini, 'Output', 'Mode') || 'Simple') ? 'AdvOut' : 'SimpleOutput';
  const seg = Math.min(300, Math.max(5, Number(segundos) || 30));
  iniSet(ini, sec, 'RecRB', 'true');
  iniSet(ini, sec, 'RecRBTime', String(seg));
  if (!iniGet(ini, sec, 'RecRBSize')) iniSet(ini, sec, 'RecRBSize', '512');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, iniToString(ini));
  return { file, segundos: seg, modo: sec };
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

module.exports = { readWebsocketConfig, detectedPassword, ensureWebsocketEnabled, findObsExe, isObsRunning, launchObs, status, WS_CONFIG, readReplaySettings, enableReplayBuffer, parseIni, iniGet, iniSet, iniToString };
