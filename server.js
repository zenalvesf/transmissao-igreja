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
  obs: { host: '127.0.0.1', port: 4455, password: '' },
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
const PAGES = { '/': 'index.html', '/cam': 'cam.html', '/view': 'view.html', '/overlay': 'overlay.html', '/mesa': 'mesa.html' };

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
  return safe;
}

async function handleApi(req, res, p) {
  try {
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
    if (p === '/api/obs/launch' && req.method === 'POST') {
      const ws = obsLocal.readWebsocketConfig();
      if (!obsLocal.isObsRunning() && !(ws && ws.enabled && ws.password)) obsLocal.ensureWebsocketEnabled();
      const r = obsLocal.launchObs();
      for (const t of [4000, 8000, 15000]) setTimeout(() => { if (!obs.connected) obs.reconnect(); }, t);
      return sendJson(res, r);
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
      } else if (c.role === 'overlay') {
        wsSend(c.ws, { type: 'overlay', overlay });
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
    } else if (op === 5) { // Event
      broadcast('mesa', { type: 'obsEvent', event: d.eventType, data: d.eventData });
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

// ---------------------------------------------------------------- multidestino
const { Relay } = require('./relay');
const relay = new Relay(() => config.relay);
relay.on('state', (state) => broadcast('mesa', { type: 'relay', state }));
relay.start();

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
