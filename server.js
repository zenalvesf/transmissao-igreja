/*
 * Transmissão Igreja — servidor local
 *  - Serve as páginas (celular, OBS, overlay, mesa)
 *  - Sinalização WebRTC entre celulares e fontes do OBS
 *  - Conexão única com o OBS (obs-websocket v5) compartilhada pela mesa
 *  - Estado do overlay (legendas, versículo, aviso, contagem) e roteiro
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const selfsigned = require('selfsigned');
const QRCode = require('qrcode');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
// Onde ficam os dados graváveis (config, roteiro, certificados). Dentro do programa instalado a
// pasta do app é somente leitura, então o app aponta TI_DATA_DIR para a pasta de dados do usuário.
const DATA_DIR = process.env.TI_DATA_DIR || ROOT;
const DATA = path.join(DATA_DIR, 'data');
const CERTS = path.join(DATA_DIR, 'certs');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const obsLocal = require('./obs-local');
if (DATA_DIR !== ROOT) { // primeira execução numa pasta nova: copia o roteiro e os modelos de exemplo
  for (const f of ['roteiro.json', 'presets.json']) {
    const dst = path.join(DATA, f), src = path.join(ROOT, 'data', f);
    if (!fs.existsSync(dst) && fs.existsSync(src)) { fs.mkdirSync(DATA, { recursive: true }); fs.copyFileSync(src, dst); }
  }
}

// ---------------------------------------------------------------- config
const DEFAULT_CONFIG = {
  httpPort: 8080,
  httpsPort: 8443,
  obs: { host: '127.0.0.1', port: 4455, password: '', invisivel: true, autoAbrir: true, saidaPendente: null },
  stun: ['stun:stun.l.google.com:19302'],
  cameraNames: ['Celular 1', 'Celular 2'],
  viewWidth: 1920,
  viewHeight: 1080,
  relay: {
    rtmpPort: 1935,
    encoder: 'auto', // codificador do recorte vertical: auto | libx264 | h264_nvenc | h264_qsv | h264_amf
    destinos: [
      { id: 'youtube', nome: 'YouTube', ativo: false, url: 'rtmp://a.rtmp.youtube.com/live2', key: '', modo: 'copy' },
      { id: 'instagram', nome: 'Instagram', ativo: false, url: '', key: '', modo: 'vertical', cropX: 0.5, res: 720, bitrate: 2500 },
    ],
  },
  holyrics: {
    host: '', port: 8091, token: '', ativo: false, intervalo: 400,
    naLive: true, // a letra que o Holyrics exibe entra na live automaticamente
    estilo: { posicao: 'inferior', tamanho: 'M', fundo: 'faixa', maiusculas: false, titulo: false },
  },
  replay: { auto: true, segundos: 30, velocidade: 100, cena: 'Replay', fonte: 'Replay (vídeo)' },
  traducao: {
    ativo: false, idiomaOrigem: 'pt-BR', idiomas: ['en'],
    provedor: 'anthropic', chave: '', modelo: 'claude-opus-5-5',
    naLive: false, idiomaLive: 'en', // legenda traduzida por cima da transmissão
  },
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

let config = Object.assign({}, DEFAULT_CONFIG, readJson(CONFIG_PATH, {}));
config.obs = Object.assign({}, DEFAULT_CONFIG.obs, config.obs || {});
config.relay = Object.assign({}, DEFAULT_CONFIG.relay, config.relay || {});
config.holyrics = Object.assign({}, DEFAULT_CONFIG.holyrics, config.holyrics || {});
config.holyrics.estilo = Object.assign({}, DEFAULT_CONFIG.holyrics.estilo, config.holyrics.estilo || {});
config.replay = Object.assign({}, DEFAULT_CONFIG.replay, config.replay || {});
config.traducao = Object.assign({}, DEFAULT_CONFIG.traducao, config.traducao || {});
if (!Array.isArray(config.relay.destinos)) config.relay.destinos = JSON.parse(JSON.stringify(DEFAULT_CONFIG.relay.destinos));
if (!fs.existsSync(CONFIG_PATH)) writeJson(CONFIG_PATH, config);

// ---------------------------------------------------------------- estado persistente
let roteiro = readJson(path.join(DATA, 'roteiro.json'), { itens: [], atual: -1 });
let presets = readJson(path.join(DATA, 'presets.json'), { legendas: [], versiculos: [], avisos: [] });

let overlay = {
  lowerThird: { visible: false, title: '', subtitle: '' },
  verse: { visible: false, ref: '', text: '' },
  ticker: { visible: false, text: '' },
  countdown: { visible: false, target: 0, message: '' },
  title: { visible: false, text: '' },
  lyrics: { visible: false, text: '', title: '', kind: '', estilo: {} }, // letra vinda do Holyrics
};

// ---------------------------------------------------------------- utilidades
function lanIps() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, ip: a.address });
    }
  }
  return out;
}

function ensureCert() {
  const keyFile = path.join(CERTS, 'key.pem');
  const certFile = path.join(CERTS, 'cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }];
  for (const { ip } of lanIps()) altNames.push({ type: 7, ip });
  const pems = selfsigned.generate([{ name: 'commonName', value: 'transmissao-igreja' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(CERTS, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  console.log('[https] certificado autoassinado gerado em', CERTS);
  return { key: pems.private, cert: pems.cert };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
};

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendJson(res, obj, status = 200) { send(res, status, JSON.stringify(obj), MIME['.json']); }
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Não encontrado');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- HTTP
const PAGES = { '/': 'index.html', '/cam': 'cam.html', '/view': 'view.html', '/overlay': 'overlay.html', '/mesa': 'mesa.html', '/multiview': 'multiview.html', '/ouvir': 'ouvir.html', '/traducao': 'traducao.html' };

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p.startsWith('/api/')) return handleApi(req, res, p, url);

  if (p === '/qr.svg') { // QR code gerado no servidor: /qr.svg?text=...
    try {
      const svg = await QRCode.toString(url.searchParams.get('text') || '', { type: 'svg', margin: 1 });
      return send(res, 200, svg, MIME['.svg']);
    } catch (e) { return send(res, 400, e.message); }
  }

  if (p.startsWith('/estingers/')) return serveFile(res, path.join(DATA, 'estingers', path.basename(decodeURIComponent(p)))); // vídeos de estinger enviados pela mesa
  if (PAGES[p]) return serveFile(res, path.join(PUBLIC, PAGES[p]));
  if (p.startsWith('/view/')) return serveFile(res, path.join(PUBLIC, 'view.html'));

  const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC, safe);
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Proibido');
  serveFile(res, file);
}

function publicConfig() {
  const safe = JSON.parse(JSON.stringify(config));
  safe.obs.hasPassword = !!safe.obs.password;
  delete safe.obs.password;
  for (const d of safe.relay.destinos) { d.hasKey = !!d.key; d.keyHint = d.key ? '••••' + d.key.slice(-4) : ''; delete d.key; }
  safe.holyrics.hasToken = !!safe.holyrics.token; delete safe.holyrics.token;
  safe.traducao.hasChave = !!safe.traducao.chave; delete safe.traducao.chave;
  return safe;
}

const ESTINGER_EXT = ['.mp4', '.webm', '.mov', '.mkv', '.avi'];
/** Recebe o vídeo de um estinger (corpo bruto, nome no cabeçalho x-nome) e guarda em data/estingers. */
function receberEstinger(req, res) {
  return new Promise((resolve) => {
    let nomeOrig = 'estinger.mp4'; try { nomeOrig = decodeURIComponent(req.headers['x-nome'] || nomeOrig); } catch { /* nome inválido */ }
    const ext = path.extname(nomeOrig).toLowerCase();
    if (!ESTINGER_EXT.includes(ext)) { sendJson(res, { error: 'Use um vídeo .webm, .mp4, .mov, .mkv ou .avi' }, 400); req.resume(); return resolve(); }
    if (Number(req.headers['content-length'] || 0) > 500e6) { sendJson(res, { error: 'Vídeo grande demais (máximo 500 MB)' }, 400); req.resume(); return resolve(); }
    const nome = (path.basename(nomeOrig, ext).replace(/[^\w.\- ]+/g, '_').slice(0, 60) || 'estinger') + ext;
    const dir = path.join(DATA, 'estingers'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, nome), out = fs.createWriteStream(file);
    let bytes = 0;
    req.on('data', (c) => { bytes += c.length; if (bytes > 500e6) req.destroy(new Error('grande demais')); });
    req.on('error', () => { out.destroy(); try { fs.unlinkSync(file); } catch { /* nada */ } if (!res.headersSent) sendJson(res, { error: 'Envio interrompido' }, 400); resolve(); });
    out.on('error', (e) => { if (!res.headersSent) sendJson(res, { error: e.message }, 500); resolve(); });
    out.on('finish', () => { sendJson(res, { ok: true, nome, arquivo: file, url: '/estingers/' + encodeURIComponent(nome), bytes }); resolve(); });
    req.pipe(out);
  });
}
function listarEstingers() {
  const dir = path.join(DATA, 'estingers');
  try { return fs.readdirSync(dir).filter((f) => ESTINGER_EXT.includes(path.extname(f).toLowerCase())).map((f) => ({ nome: f, arquivo: path.join(dir, f), url: '/estingers/' + encodeURIComponent(f) })); } catch { return []; }
}

async function handleApi(req, res, p) {
  try {
    if (p === '/api/transicoes/arquivo' && req.method === 'POST') return receberEstinger(req, res);
    if (p === '/api/info') {
      return sendJson(res, {
        ips: lanIps(), httpPort: config.httpPort, httpsPort: config.httpsPort,
        cameraNames: config.cameraNames, stun: config.stun,
        viewWidth: config.viewWidth, viewHeight: config.viewHeight,
        cams: camList(), obsConnected: obs.connected,
      });
    }
    if (p === '/api/roteiro') {
      if (req.method === 'PUT') {
        roteiro = await readBody(req);
        writeJson(path.join(DATA, 'roteiro.json'), roteiro);
        broadcast('mesa', { type: 'roteiro', roteiro });
      }
      return sendJson(res, roteiro);
    }
    if (p === '/api/presets') {
      if (req.method === 'PUT') {
        presets = await readBody(req);
        writeJson(path.join(DATA, 'presets.json'), presets);
        broadcast('mesa', { type: 'presets', presets });
      }
      return sendJson(res, presets);
    }
    if (p === '/api/config') {
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (body.obs) {
          const patch = Object.assign({}, body.obs);
          if (patch.password === undefined || patch.password === null) delete patch.password;
          config.obs = Object.assign({}, config.obs, patch);
        }
        if (Array.isArray(body.cameraNames)) config.cameraNames = body.cameraNames.map((s) => String(s).trim()).filter(Boolean);
        if (Array.isArray(body.stun)) config.stun = body.stun;
        writeJson(CONFIG_PATH, config);
        obs.reconnect();
        broadcast('mesa', { type: 'config', config: publicConfig() });
      }
      return sendJson(res, publicConfig());
    }
    // Multidestino (relay)
    if (p === '/api/relay') return sendJson(res, relay.state());
    if (p === '/api/relay/destinos' && req.method === 'PUT') {
      const body = await readBody(req);
      if (body.encoder) config.relay.encoder = String(body.encoder);
      if (Array.isArray(body.destinos)) {
        const old = new Map(config.relay.destinos.map((d) => [d.id, d]));
        config.relay.destinos = body.destinos.filter((d) => d && d.id).map((d) => {
          const prev = old.get(d.id) || {};
          const nd = {
            id: String(d.id), nome: String(d.nome || d.id).trim() || d.id, ativo: !!d.ativo,
            url: String(d.url || '').trim(), modo: d.modo === 'vertical' ? 'vertical' : 'copy',
            cropX: Math.min(1, Math.max(0, Number(d.cropX ?? prev.cropX ?? 0.5))),
            res: Number(d.res) === 1080 ? 1080 : 720, bitrate: Number(d.bitrate) || prev.bitrate || 2500,
            key: typeof d.key === 'string' && d.key.trim() ? d.key.trim() : (prev.key || ''),
          };
          if (d.key === '') nd.key = prev.key || ''; // em branco = manter
          if (d.limparKey) nd.key = '';
          return nd;
        });
      }
      writeJson(CONFIG_PATH, config);
      relay.applyConfig();
      broadcast('mesa', { type: 'config', config: publicConfig() });
      return sendJson(res, publicConfig());
    }
    {
      const m = p.match(/^\/api\/relay\/(restart|log)\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[2]);
        if (m[1] === 'restart') { relay.restartDest(id); return sendJson(res, { ok: true }); }
        return sendJson(res, { lines: relay.logOf(id) });
      }
    }
    // Replay instantâneo (buffer de replay do OBS)
    if (p === '/api/replay' && req.method === 'PUT') {
      const body = await readBody(req);
      const r = config.replay;
      if (body.auto !== undefined) r.auto = !!body.auto;
      if (body.segundos !== undefined) r.segundos = Math.min(300, Math.max(5, Number(body.segundos) || 30));
      if (body.velocidade !== undefined) r.velocidade = Math.min(200, Math.max(25, Number(body.velocidade) || 100));
      writeJson(CONFIG_PATH, config);
      broadcast('mesa', { type: 'config', config: publicConfig() });
      replay.emitState();
      return sendJson(res, { config: publicConfig(), state: replay.state() });
    }
    if (p === '/api/replay') return sendJson(res, Object.assign(replay.state(), { obsLocal: obsLocal.readReplaySettings() }));
    {
      const m = p.match(/^\/api\/replay\/(ligar|desligar|salvar|exibir|voltar|ativar-obs)$/);
      if (m && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        try {
          if (m[1] === 'ligar') { await replay.ligar(false); return sendJson(res, { ok: true }); }
          if (m[1] === 'desligar') { await replay.desligar(); return sendJson(res, { ok: true }); }
          if (m[1] === 'salvar') return sendJson(res, { ok: true, salvo: await replay.salvar() });
          if (m[1] === 'exibir') { await replay.exibir(body.arquivo, body.velocidade); return sendJson(res, { ok: true }); }
          if (m[1] === 'voltar') { await replay.voltar(); return sendJson(res, { ok: true }); }
          // ativa o buffer no perfil do OBS (OBS fechado) e abre o OBS de novo
          const r = obsLocal.enableReplayBuffer(config.replay.segundos);
          let launched = null; try { launched = obsLocal.launchObs(); } catch { /* OBS não encontrado: só configurou */ }
          for (const t of [5000, 10000, 20000]) setTimeout(() => { if (!obs.connected) obs.reconnect(); }, t);
          return sendJson(res, { ok: true, arquivo: r.file, segundos: r.segundos, launched: !!(launched && launched.started) });
        } catch (e) { return sendJson(res, { ok: false, erro: String(e.message || e) }); }
      }
    }
    // Holyrics (letra do telão na live)
    if (p === '/api/holyrics' && req.method === 'PUT') {
      const body = await readBody(req);
      const h = config.holyrics;
      if (body.host !== undefined) h.host = String(body.host).trim();
      if (body.port !== undefined) h.port = Number(body.port) || 8091;
      if (typeof body.token === 'string' && body.token.trim()) h.token = body.token.trim(); // em branco = manter
      if (body.limparToken) h.token = '';
      if (body.ativo !== undefined) h.ativo = !!body.ativo;
      if (body.naLive !== undefined) h.naLive = !!body.naLive;
      if (body.intervalo !== undefined) h.intervalo = Math.max(200, Number(body.intervalo) || 400);
      if (body.estilo && typeof body.estilo === 'object') {
        const e = body.estilo;
        h.estilo = {
          posicao: e.posicao === 'superior' ? 'superior' : 'inferior',
          tamanho: ['P', 'M', 'G'].includes(e.tamanho) ? e.tamanho : 'M',
          fundo: ['faixa', 'caixa', 'sombra'].includes(e.fundo) ? e.fundo : 'faixa',
          maiusculas: !!e.maiusculas, titulo: !!e.titulo,
        };
      }
      writeJson(CONFIG_PATH, config);
      holyrics.aplicarConfig();
      syncLyrics();
      broadcast('mesa', { type: 'config', config: publicConfig() });
      return sendJson(res, { config: publicConfig(), state: holyrics.state() });
    }
    if (p === '/api/holyrics') return sendJson(res, holyrics.state());
    if (p === '/api/holyrics/testar' && req.method === 'POST') {
      const body = await readBody(req);
      const token = (typeof body.token === 'string' && body.token.trim()) ? body.token.trim() : config.holyrics.token;
      try { return sendJson(res, await Holyrics.testar({ host: String(body.host || config.holyrics.host).trim(), port: Number(body.port) || config.holyrics.port, token })); }
      catch (e) { return sendJson(res, { ok: false, erro: String(e.message || e) }); }
    }
    // Transições (estinger etc.) na coleção de cenas do OBS
    if (p === '/api/transicoes' && req.method === 'GET') {
      return sendJson(res, { colecao: obsLocal.readTransitions(), obsAberto: obsLocal.isObsRunning(), obsInstalado: !!obsLocal.findObsExe(), tipos: obsLocal.TRANSICAO_TIPOS, estingers: listarEstingers() });
    }
    if (p === '/api/transicoes' && req.method === 'PUT') {
      const body = await readBody(req);
      if (obs.connected) { try { if ((await obs.call('GetStreamStatus')).outputActive) return sendJson(res, { error: 'O OBS está transmitindo. Pare a transmissão antes de mudar as transições.' }, 400); } catch { /* segue */ } }
      const estavaAberto = obsLocal.isObsRunning();
      if (estavaAberto) { const c = await obsLocal.closeObs(); if (!c.closed) return sendJson(res, { error: 'O OBS não fechou. Feche pela bandeja do Windows e tente de novo.' }, 400); }
      let colecao = null, erro = null;
      try { colecao = obsLocal.writeTransitions(body); } catch (e) { erro = e.message; }
      let reabriu = false;
      if (estavaAberto || (config.obs.autoAbrir !== false && obsLocal.findObsExe())) { try { abrirObs(); reabriu = true; } catch (e) { console.warn('[transicoes] não reabriu o OBS:', e.message); } }
      if (erro) return sendJson(res, { error: erro, reabriu }, 400);
      console.log('[transicoes] coleção atualizada:', (body.adicionar || []).map((t) => t.nome).join(', ') || '-', 'removidas:', (body.remover || []).join(', ') || '-');
      return sendJson(res, { ok: true, colecao, reabriu });
    }
    if (p === '/api/transicoes/estinger' && req.method === 'DELETE') {
      const body = await readBody(req);
      const f = listarEstingers().find((e) => e.nome === body.nome);
      if (f) fs.unlinkSync(f.arquivo);
      return sendJson(res, { ok: !!f, estingers: listarEstingers() });
    }
    // Tradução ao vivo
    if (p === '/api/traducao' && req.method === 'PUT') {
      const body = await readBody(req), t = config.traducao;
      if (typeof body.chave === 'string' && body.chave.trim()) t.chave = body.chave.trim();
      if (body.chave === null) t.chave = '';
      if (body.ativo !== undefined) t.ativo = !!body.ativo;
      if (body.naLive !== undefined) t.naLive = !!body.naLive;
      if (typeof body.provedor === 'string' && PROVEDORES[body.provedor]) t.provedor = body.provedor;
      if (typeof body.modelo === 'string' && MODELOS[body.modelo]) t.modelo = body.modelo;
      if (Array.isArray(body.idiomas)) t.idiomas = body.idiomas.filter((i) => IDIOMAS[i] && i !== 'pt-BR');
      if (typeof body.idiomaLive === 'string' && IDIOMAS[body.idiomaLive]) t.idiomaLive = body.idiomaLive;
      if (typeof body.idiomaOrigem === 'string' && body.idiomaOrigem.trim()) t.idiomaOrigem = body.idiomaOrigem.trim();
      writeJson(CONFIG_PATH, config);
      syncTraducao();
      traducao.emitState();
      broadcast('ouvinte', { type: 'traducaoConfig', idiomaOrigem: t.idiomaOrigem });
      broadcast('traducao', { type: 'traducao', state: traducao.state() });
      broadcast('mesa', { type: 'config', config: publicConfig() });
      return sendJson(res, { config: publicConfig(), state: traducao.state() });
    }
    if (p === '/api/traducao') return sendJson(res, traducao.state());
    if (p === '/api/traducao/testar' && req.method === 'POST') {
      const body = await readBody(req);
      const c = Object.assign({}, traducao.cfg());
      for (const k of ['provedor', 'modelo', 'idiomas']) if (body[k] !== undefined) c[k] = body[k];
      if (typeof body.chave === 'string' && body.chave.trim()) c.chave = body.chave.trim();
      try { return sendJson(res, await Traducao.testar(c)); }
      catch (e) { return sendJson(res, { ok: false, erro: traduzErro(e) }); }
    }
    if (p === '/api/traducao/limpar' && req.method === 'POST') { traducao.limpar(); broadcast('traducao', { type: 'limpar' }); return sendJson(res, { ok: true }); }
    if (p === '/api/traducao/abrir-ouvinte' && req.method === 'POST') return sendJson(res, await abrirOuvinte());
    // OBS instalado neste computador
    if (p === '/api/obs/local') {
      return sendJson(res, Object.assign(obsLocal.status(), {
        connected: obs.connected,
        usingDetectedPassword: !config.obs.password && !!obsLocal.detectedPassword(),
      }));
    }
    if (p === '/api/obs/enable-websocket' && req.method === 'POST') {
      const wasRunning = obsLocal.isObsRunning();
      const r = obsLocal.ensureWebsocketEnabled();
      if (r.port !== config.obs.port) { config.obs.port = r.port; writeJson(CONFIG_PATH, config); }
      setTimeout(() => obs.reconnect(), 1000);
      return sendJson(res, { enabled: true, port: r.port, needsRestart: wasRunning });
    }
    if (p === '/api/obs/launch' && req.method === 'POST') return sendJson(res, abrirObs());
    if (p === '/api/obs/fechar' && req.method === 'POST') {
      if (obs.connected) { try { if ((await obs.call('GetStreamStatus')).outputActive) return sendJson(res, { error: 'O OBS está transmitindo. Pare a transmissão antes de fechar.' }, 400); } catch { /* segue */ } }
      return sendJson(res, await obsLocal.closeObs());
    }
    if (p === '/api/obs/reiniciar' && req.method === 'POST') {
      if (obs.connected) { try { if ((await obs.call('GetStreamStatus')).outputActive) return sendJson(res, { error: 'O OBS está transmitindo. Pare a transmissão antes.' }, 400); } catch { /* segue */ } }
      const c = await obsLocal.closeObs();
      if (!c.closed) return sendJson(res, { error: 'O OBS não fechou. Feche pela bandeja do Windows e abra de novo pela mesa.' }, 400);
      return sendJson(res, abrirObs());
    }
    if (p === '/api/obs/saida') {
      let resultado = null;
      if (req.method === 'PUT') {
        const b = await readBody(req);
        const q = {
          largura: Number(b.largura) || 1920, altura: Number(b.altura) || 1080, fps: [24, 25, 30, 60].includes(Number(b.fps)) ? Number(b.fps) : 30,
          bitrate: Math.max(500, Math.min(20000, Number(b.bitrate) || 3000)), encoder: ['x264', 'nvenc', 'qsv', 'amd'].includes(b.encoder) ? b.encoder : 'x264',
          baseLargura: config.viewWidth || 1920, baseAltura: config.viewHeight || 1080,
        };
        const r = { aplicado: [], pendente: false };
        // resolução e fps valem na hora pelo WebSocket (fora de transmissão); taxa de bits e codificador só no perfil
        if (obs.connected) {
          try {
            await obs.call('SetVideoSettings', { baseWidth: q.baseLargura, baseHeight: q.baseAltura, outputWidth: q.largura, outputHeight: q.altura, fpsNumerator: q.fps, fpsDenominator: 1 });
            r.aplicado.push('resolução e fps');
          } catch (e) { r.avisoVideo = 'Resolução/fps não mudaram agora: ' + e.message; }
        }
        if (obsLocal.isObsRunning()) { config.obs.saidaPendente = q; r.pendente = true; }
        else { try { obsLocal.writeOutputSettings(q); config.obs.saidaPendente = null; r.aplicado.push('taxa de bits e codificador'); } catch (e) { r.erro = e.message; } }
        writeJson(CONFIG_PATH, config);
        resultado = r;
      }
      let video = null; if (obs.connected) { try { video = await obs.call('GetVideoSettings'); } catch { /* ignorar */ } }
      return sendJson(res, { perfil: obsLocal.readOutputSettings(), video, pendente: config.obs.saidaPendente, hardware: obsLocal.hardwareEncoders(), gpus: obsLocal.detectGpus(), running: obsLocal.isObsRunning(), connected: obs.connected, resultado });
    }
    send(res, 404, 'API não encontrada');
  } catch (e) {
    sendJson(res, { error: String(e.message || e) }, 400);
  }
}

// ---------------------------------------------------------------- WebSocket hub
/** clients: id -> { id, ws, role, name, meta, alive, since } */
const clients = new Map();
let nextId = 1;

function wsSend(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(role, obj) { for (const c of clients.values()) if (c.role === role) wsSend(c.ws, obj); }
function camsByName(name) { return [...clients.values()].filter((c) => c.role === 'cam' && c.name === name); }
function viewsFor(name) { return [...clients.values()].filter((c) => c.role === 'view' && c.name === name); }
function camList() {
  return [...clients.values()].filter((c) => c.role === 'cam').map((c) => ({
    id: c.id, name: c.name, meta: c.meta, viewers: viewsFor(c.name).length, since: c.since,
  }));
}
function pushCamList() { broadcast('mesa', { type: 'cams', cams: camList() }); }

function onWsMessage(c, raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  switch (m.type) {
    case 'hello': {
      c.role = m.role; c.name = m.name || m.cam || ''; c.meta = m.meta || {}; c.since = Date.now();
      wsSend(c.ws, { type: 'welcome', id: c.id, stun: config.stun });
      if (c.role === 'cam') {
        // Um celular por nome: o novo substitui o antigo (ex.: recarregou a página)
        for (const old of camsByName(c.name)) {
          if (old.id !== c.id) { wsSend(old.ws, { type: 'replaced' }); old.ws.close(); clients.delete(old.id); }
        }
        for (const v of viewsFor(c.name)) {
          wsSend(c.ws, { type: 'viewerJoined', viewerId: v.id });
          wsSend(v.ws, { type: 'camOnline', camId: c.id });
        }
        pushCamList();
      } else if (c.role === 'view') {
        const cam = camsByName(c.name)[0];
        if (cam) {
          wsSend(cam.ws, { type: 'viewerJoined', viewerId: c.id });
          wsSend(c.ws, { type: 'camOnline', camId: cam.id });
        } else {
          wsSend(c.ws, { type: 'camOffline' });
        }
        pushCamList();
      } else if (c.role === 'mesa') {
        wsSend(c.ws, { type: 'cams', cams: camList() });
        wsSend(c.ws, { type: 'overlay', overlay });
        wsSend(c.ws, { type: 'roteiro', roteiro });
        wsSend(c.ws, { type: 'presets', presets });
        wsSend(c.ws, { type: 'config', config: publicConfig() });
        wsSend(c.ws, { type: 'obsStatus', connected: obs.connected, error: obs.lastError });
        wsSend(c.ws, { type: 'relay', state: relay.state() });
        wsSend(c.ws, { type: 'holyrics', state: holyrics.state() });
        wsSend(c.ws, { type: 'replay', state: replay.state() });
        wsSend(c.ws, { type: 'traducao', state: traducao.state() });
      } else if (c.role === 'overlay') {
        wsSend(c.ws, { type: 'overlay', overlay });
      } else if (c.role === 'traducao') { // celular de quem lê a tradução
        wsSend(c.ws, { type: 'traducao', state: traducao.state() });
      } else if (c.role === 'ouvinte') { // página que escuta o microfone
        wsSend(c.ws, { type: 'traducaoConfig', idiomaOrigem: config.traducao.idiomaOrigem });
        // um ouvinte por vez: o novo manda o antigo parar, para não reconhecer em dobro
        for (const old of clients.values()) if (old.role === 'ouvinte' && old.id !== c.id) wsSend(old.ws, { type: 'ouvinteCmd', cmd: 'parar' });
        traducao.onOuvinte(c.id, { estado: 'conectado' });
      }
      break;
    }
    case 'signal': { // relé WebRTC: { to, data }
      const t = clients.get(m.to);
      if (t) wsSend(t.ws, { type: 'signal', from: c.id, data: m.data });
      break;
    }
    case 'camStats': {
      c.meta = Object.assign({}, c.meta, m.stats);
      broadcast('mesa', { type: 'camStats', id: c.id, name: c.name, stats: m.stats });
      break;
    }
    case 'camControl': { // mesa -> celular
      for (const cam of camsByName(m.cam)) wsSend(cam.ws, { type: 'control', cmd: m.cmd, value: m.value });
      break;
    }
    case 'overlay': { // mesa -> todos
      for (const [k, v] of Object.entries(m.patch || {})) overlay[k] = Object.assign({}, overlay[k] || {}, v);
      broadcast('overlay', { type: 'overlay', overlay });
      broadcast('mesa', { type: 'overlay', overlay });
      break;
    }
    case 'obs': { // mesa -> OBS: { id, request, data }
      obs.call(m.request, m.data).then(
        (data) => wsSend(c.ws, { type: 'obsResult', id: m.id, ok: true, data }),
        (err) => wsSend(c.ws, { type: 'obsResult', id: m.id, ok: false, error: String(err.message || err) }),
      );
      break;
    }
    case 'obsBatch': { // mesa -> OBS: vários pedidos em sequência
      (async () => {
        const results = [];
        for (const r of m.requests || []) {
          try { results.push({ ok: true, data: await obs.call(r.request, r.data) }); }
          catch (e) { results.push({ ok: false, error: String(e.message || e) }); }
        }
        wsSend(c.ws, { type: 'obsResult', id: m.id, ok: true, data: results });
      })();
      break;
    }
    case 'fala': if (c.role === 'ouvinte') traducao.onFala(m); break; // ouvinte -> tradução
    case 'ouvinte': if (c.role === 'ouvinte') traducao.onOuvinte(c.id, m); break;
    case 'ping': wsSend(c.ws, { type: 'pong', t: m.t }); break;
    default: break;
  }
}

function attachWss(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    const c = { id: String(nextId++), ws, role: '', name: '', meta: {}, alive: true, since: Date.now() };
    clients.set(c.id, c);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (raw) => onWsMessage(c, raw));
    ws.on('close', () => {
      clients.delete(c.id);
      if (c.role === 'cam') {
        for (const v of viewsFor(c.name)) wsSend(v.ws, { type: 'camOffline' });
        pushCamList();
      }
      if (c.role === 'view') {
        for (const cam of camsByName(c.name)) wsSend(cam.ws, { type: 'viewerLeft', viewerId: c.id });
        pushCamList();
      }
      if (c.role === 'ouvinte') traducao.ouvinteSaiu(c.id);
    });
  });
  setInterval(() => {
    for (const c of clients.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* ignorar */ }
    }
  }, 15000);
  return wss;
}

// ---------------------------------------------------------------- OBS (obs-websocket v5)
class ObsClient {
  constructor() {
    this.ws = null; this.connected = false; this.lastError = '';
    this.pending = new Map(); this.reqId = 1; this.timer = null;
  }
  reconnect() {
    clearTimeout(this.timer);
    if (this.ws) { try { this.ws.close(); } catch { /* ignorar */ } this.ws = null; }
    this.connect();
  }
  connect() {
    clearTimeout(this.timer);
    const url = `ws://${config.obs.host}:${config.obs.port}`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.fail(e); return; }
    this.ws = ws;
    ws.on('message', (raw) => { try { this.onMessage(JSON.parse(raw)); } catch (e) { console.error('[obs] mensagem inválida', e.message); } });
    ws.on('error', (e) => { this.lastError = e.message; });
    ws.on('close', () => {
      if (this.ws !== ws) return; // conexão antiga descartada
      const was = this.connected;
      this.connected = false; this.ws = null;
      for (const p of this.pending.values()) p.reject(new Error('OBS desconectou'));
      this.pending.clear();
      if (was) console.log('[obs] desconectado');
      if (was && this.onDisconnected) this.onDisconnected();
      broadcast('mesa', { type: 'obsStatus', connected: false, error: this.lastError });
      this.timer = setTimeout(() => this.connect(), 3000);
    });
  }
  fail(e) { this.lastError = e.message; this.timer = setTimeout(() => this.connect(), 3000); }
  onMessage(msg) {
    const { op, d } = msg;
    if (op === 0) { // Hello
      const ident = { rpcVersion: 1, eventSubscriptions: (1 << 11) - 1 - (1 << 9) /* tudo menos medidores de volume */ };
      if (d.authentication) {
        const { challenge, salt } = d.authentication;
        const secret = crypto.createHash('sha256').update((config.obs.password || obsLocal.detectedPassword()) + salt).digest('base64');
        ident.authentication = crypto.createHash('sha256').update(secret + challenge).digest('base64');
      }
      this.ws.send(JSON.stringify({ op: 1, d: ident }));
    } else if (op === 2) { // Identified
      this.connected = true; this.lastError = '';
      console.log('[obs] conectado');
      broadcast('mesa', { type: 'obsStatus', connected: true });
      if (this.onConnected) this.onConnected();
    } else if (op === 5) { // Event
      broadcast('mesa', { type: 'obsEvent', event: d.eventType, data: d.eventData });
      if (this.onEvent) this.onEvent(d.eventType, d.eventData || {});
    } else if (op === 7) { // RequestResponse
      const p = this.pending.get(d.requestId);
      if (!p) return;
      this.pending.delete(d.requestId);
      if (d.requestStatus.result) p.resolve(d.responseData || {});
      else p.reject(new Error(d.requestStatus.comment || `OBS erro ${d.requestStatus.code}`));
    }
  }
  call(requestType, requestData) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('OBS não conectado'));
      const requestId = String(this.reqId++);
      this.pending.set(requestId, { resolve, reject });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      setTimeout(() => { if (this.pending.delete(requestId)) reject(new Error('OBS não respondeu')); }, 10000);
    });
  }
}
const obs = new ObsClient();
obs.connect();

/** Abre o OBS do jeito configurado (escondido na bandeja ou com janela), aplicando antes a qualidade pendente. */
function abrirObs() {
  const ws = obsLocal.readWebsocketConfig();
  if (!obsLocal.isObsRunning() && !(ws && ws.enabled && ws.password)) obsLocal.ensureWebsocketEnabled();
  if (!obsLocal.isObsRunning() && config.obs.saidaPendente) {
    try { obsLocal.writeOutputSettings(config.obs.saidaPendente); config.obs.saidaPendente = null; writeJson(CONFIG_PATH, config); console.log('[obs] qualidade pendente aplicada no perfil'); }
    catch (e) { console.warn('[obs] qualidade pendente não aplicada:', e.message); }
  }
  const r = obsLocal.launchObs({ invisivel: config.obs.invisivel !== false });
  for (const t of [4000, 8000, 15000, 30000]) setTimeout(() => { if (!obs.connected) obs.reconnect(); }, t);
  return r;
}
// Abre o OBS junto com o programa (o operador nunca precisa ver a janela do OBS)
setTimeout(() => {
  try {
    if (config.obs.autoAbrir !== false && obsLocal.findObsExe() && !obsLocal.isObsRunning()) { abrirObs(); console.log('[obs] aberto automaticamente' + (config.obs.invisivel !== false ? ' (escondido na bandeja)' : '')); }
  } catch (e) { console.warn('[obs] não abriu sozinho:', e.message); }
}, 1500);

// ---------------------------------------------------------------- multidestino
const { Relay } = require('./relay');
const relay = new Relay(() => config.relay);
relay.on('state', (state) => broadcast('mesa', { type: 'relay', state }));
relay.start();

// ---------------------------------------------------------------- Holyrics (letra do telão)
const { Holyrics } = require('./holyrics');
const holyrics = new Holyrics(() => config.holyrics);
/** Copia o texto atual do Holyrics para a camada "lyrics" do overlay e avisa todo mundo. */
function syncLyrics() {
  const h = config.holyrics, s = holyrics.state();
  const next = { visible: !!(h.ativo && h.naLive && s.texto), text: s.texto, title: s.titulo, kind: s.atual ? s.atual.type : '', estilo: Object.assign({}, h.estilo) };
  if (JSON.stringify(next) === JSON.stringify(overlay.lyrics)) return;
  overlay.lyrics = next;
  broadcast('overlay', { type: 'overlay', overlay });
  broadcast('mesa', { type: 'overlay', overlay });
}
holyrics.on('state', (state) => broadcast('mesa', { type: 'holyrics', state }));
holyrics.on('texto', syncLyrics);
holyrics.start();
syncLyrics();

// ---------------------------------------------------------------- Replay instantâneo
const { Replay } = require('./replay');
const replay = new Replay(obs, () => config.replay);
replay.on('state', (state) => broadcast('mesa', { type: 'replay', state }));
obs.onConnected = () => replay.onConnected().catch((e) => console.warn('[replay]', e.message));
obs.onDisconnected = () => replay.onDisconnected();
obs.onEvent = (tipo, d) => replay.onEvent(tipo, d);
if (obs.connected) obs.onConnected();

// ---------------------------------------------------------------- Tradução ao vivo
const { Traducao, IDIOMAS, MODELOS, PROVEDORES, traduzErro } = require('./traducao');
const traducao = new Traducao(() => config.traducao);
let parcialTimer = null, legendaTimer = null;
traducao.on('state', (state) => broadcast('mesa', { type: 'traducao', state }));
traducao.on('traducao', (item) => { broadcast('traducao', { type: 'item', item }); syncTraducao(); });
traducao.on('limpar', () => syncTraducao());
traducao.on('parcial', () => {
  if (parcialTimer) return; // no máximo ~3 vezes por segundo
  parcialTimer = setTimeout(() => {
    parcialTimer = null;
    broadcast('traducao', { type: 'parcial', texto: traducao.parcial });
    broadcast('mesa', { type: 'traducaoParcial', texto: traducao.parcial });
  }, 300);
});
/** Última frase traduzida como legenda da transmissão (camada "legenda" do overlay); some após 25 s sem fala nova. */
function syncTraducao() {
  const t = config.traducao, ult = traducao.historico[traducao.historico.length - 1];
  const texto = ult ? ((ult.traducoes || {})[t.idiomaLive] || '') : '';
  const next = { visible: !!(t.ativo && t.naLive && texto), text: texto, idioma: t.idiomaLive };
  clearTimeout(legendaTimer);
  if (next.visible) legendaTimer = setTimeout(() => { overlay.legenda = Object.assign({}, overlay.legenda, { visible: false }); broadcast('overlay', { type: 'overlay', overlay }); broadcast('mesa', { type: 'overlay', overlay }); }, 25000);
  if (JSON.stringify(next) === JSON.stringify(overlay.legenda)) return;
  overlay.legenda = next;
  broadcast('overlay', { type: 'overlay', overlay });
  broadcast('mesa', { type: 'overlay', overlay });
}
syncTraducao();
/** Abre a página do ouvinte num navegador com reconhecimento de voz (Edge ou Chrome); o Electron não tem. */
function abrirOuvinte() {
  const { exec } = require('child_process');
  const url = `http://localhost:${config.httpPort}/ouvir?auto`;
  const tentativas = [['Edge', `start "" msedge --new-window --app="${url}"`], ['Chrome', `start "" chrome --new-window --app="${url}"`], ['navegador padrão', `start "" "${url}"`]];
  return new Promise((resolve) => {
    const tentar = (i) => {
      if (i >= tentativas.length) return resolve({ ok: false, erro: 'Não achei um navegador. Abra http://localhost:' + config.httpPort + '/ouvir no Edge ou Chrome.' });
      exec(tentativas[i][1], { windowsHide: true, timeout: 8000 }, (err) => { if (err) tentar(i + 1); else resolve({ ok: true, navegador: tentativas[i][0], url }); });
    };
    tentar(0);
  });
}

// ---------------------------------------------------------------- start
const httpServer = http.createServer(handleHttp);
attachWss(httpServer);
httpServer.listen(config.httpPort, () => {
  console.log('');
  console.log('=== Transmissão Igreja ===');
  console.log(`[http]  Mesa:      http://localhost:${config.httpPort}/mesa`);
  console.log(`[http]  Página inicial com QR codes: http://localhost:${config.httpPort}/`);
});

try {
  const httpsServer = https.createServer(ensureCert(), handleHttp);
  attachWss(httpsServer);
  httpsServer.listen(config.httpsPort, () => {
    for (const { ip } of lanIps()) console.log(`[https] Celulares: https://${ip}:${config.httpsPort}/cam`);
  });
} catch (e) {
  console.error('[https] não foi possível iniciar HTTPS:', e.message);
}

process.on('uncaughtException', (e) => console.error('[erro]', e));

module.exports = { config, obs, lanIps, publicConfig, DATA_DIR, obsLocal };
