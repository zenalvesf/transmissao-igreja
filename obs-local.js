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

/** Abre o OBS. invisivel: só na bandeja, sem janela (o motor roda escondido e a mesa é a interface). */
function launchObs(opts) {
  const exe = findObsExe();
  if (!exe) throw new Error('OBS não encontrado. Instale o OBS Studio em https://obsproject.com');
  if (isObsRunning()) return { started: false, exe };
  const args = ['--disable-shutdown-check', '--disable-updater'];
  if (opts && opts.invisivel) args.push('--minimize-to-tray');
  // O OBS exige ser iniciado a partir da própria pasta bin/64bit
  const child = spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { started: true, exe, args };
}

/** Pede ao OBS para fechar (como clicar no X). Devolve uma promessa que resolve quando ele sumiu (ou após 15 s). */
function closeObs() {
  if (!isObsRunning()) return Promise.resolve({ closed: true, wasRunning: false });
  try { execFileSync('taskkill', ['/IM', 'obs64.exe'], QUIET); } catch { /* pode já ter fechado */ }
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => { if (!isObsRunning()) return resolve({ closed: true, wasRunning: true }); if (Date.now() - t0 > 15000) return resolve({ closed: false, wasRunning: true }); setTimeout(tick, 500); };
    setTimeout(tick, 800);
  });
}

// ---- Placa de vídeo: para sugerir o codificador por hardware que existe de verdade
let gpuCache = null;
function detectGpus() {
  if (gpuCache) return gpuCache;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name'], Object.assign({ timeout: 8000 }, QUIET));
    gpuCache = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  } catch { gpuCache = []; }
  return gpuCache;
}
/** Codificadores por hardware prováveis nesta máquina: nvenc | qsv | amd (pela placa de vídeo). */
function hardwareEncoders() {
  const g = detectGpus().join(' ');
  const out = [];
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(g)) out.push('nvenc');
  if (/intel/i.test(g)) out.push('qsv');
  if (/amd|radeon/i.test(g)) out.push('amd');
  return out;
}

// ---- Qualidade da transmissão no perfil do OBS (basic.ini)
const ENCODER_INI = { x264: 'x264', nvenc: 'jim_nvenc', qsv: 'qsv', amd: 'amd' };
const ENCODER_NOME = { x264: 'processador (x264)', jim_nvenc: 'placa NVIDIA (NVENC)', nvenc: 'placa NVIDIA (NVENC)', ffmpeg_nvenc: 'placa NVIDIA (NVENC)', qsv: 'Intel QuickSync', amd: 'placa AMD', x264_lowcpu: 'processador (x264, uso baixo)' };

/** Lê o que está no perfil: { file, bitrate, encoder, encoderNome, largura, altura, fps, baseLargura, baseAltura } ou null. */
function readOutputSettings() {
  const file = path.join(profileDir(), 'basic.ini');
  let ini; try { ini = parseIni(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const adv = /advanced/i.test(iniGet(ini, 'Output', 'Mode') || 'Simple');
  const enc = adv ? (iniGet(ini, 'AdvOut', 'Encoder') || '') : (iniGet(ini, 'SimpleOutput', 'StreamEncoder') || 'x264');
  return {
    file, modo: adv ? 'Advanced' : 'Simple',
    bitrate: Number(adv ? '' : iniGet(ini, 'SimpleOutput', 'VBitrate')) || 0,
    encoder: enc, encoderNome: ENCODER_NOME[enc] || enc,
    baseLargura: Number(iniGet(ini, 'Video', 'BaseCX')) || 0, baseAltura: Number(iniGet(ini, 'Video', 'BaseCY')) || 0,
    largura: Number(iniGet(ini, 'Video', 'OutputCX')) || 0, altura: Number(iniGet(ini, 'Video', 'OutputCY')) || 0,
    fps: Number(iniGet(ini, 'Video', 'FPSCommon')) || 0,
  };
}

/** Grava qualidade no perfil (OBS fechado): q = { largura, altura, fps, bitrate, encoder: x264|nvenc|qsv|amd }. */
function writeOutputSettings(q) {
  if (isObsRunning()) throw new Error('Feche o OBS primeiro: ele regrava as configurações ao fechar.');
  const file = path.join(profileDir(), 'basic.ini');
  let ini; try { ini = parseIni(fs.readFileSync(file, 'utf8')); } catch { ini = parseIni(''); }
  iniSet(ini, 'Output', 'Mode', 'Simple');
  if (q.bitrate) iniSet(ini, 'SimpleOutput', 'VBitrate', String(Math.max(500, Math.min(20000, Number(q.bitrate)))));
  if (q.encoder && ENCODER_INI[q.encoder]) {
    iniSet(ini, 'SimpleOutput', 'StreamEncoder', ENCODER_INI[q.encoder]);
    if (q.encoder === 'x264') iniSet(ini, 'SimpleOutput', 'Preset', 'veryfast');
  }
  iniSet(ini, 'SimpleOutput', 'UseAdvanced', 'false');
  if (!iniGet(ini, 'SimpleOutput', 'ABitrate')) iniSet(ini, 'SimpleOutput', 'ABitrate', '160');
  iniSet(ini, 'Video', 'BaseCX', String(q.baseLargura || 1920)); iniSet(ini, 'Video', 'BaseCY', String(q.baseAltura || 1080));
  if (q.largura && q.altura) { iniSet(ini, 'Video', 'OutputCX', String(q.largura)); iniSet(ini, 'Video', 'OutputCY', String(q.altura)); }
  if (q.fps) { iniSet(ini, 'Video', 'FPSType', '0'); iniSet(ini, 'Video', 'FPSCommon', String(q.fps)); }
  if (!iniGet(ini, 'Video', 'ScaleType')) iniSet(ini, 'Video', 'ScaleType', 'bicubic');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, iniToString(ini));
  return { file };
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
  if (!sec) { const last = ini.secoes[ini.secoes.length - 1]; if (last.linhas.length && last.linhas[last.linhas.length - 1].trim() !== '') last.linhas.push(''); sec = { nome: secao, linhas: [] }; ini.secoes.push(sec); }
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

module.exports = { readWebsocketConfig, detectedPassword, ensureWebsocketEnabled, findObsExe, isObsRunning, launchObs, closeObs, status, WS_CONFIG, readReplaySettings, enableReplayBuffer, readOutputSettings, writeOutputSettings, ENCODER_NOME, detectGpus, hardwareEncoders, parseIni, iniGet, iniSet, iniToString };
