/* Holyrics: lê pela API Server (Menu arquivo > Configurações > API Server) o que está sendo
 * exibido no telão e entrega o texto do slide atual para a camada de letra do overlay.
 * Consulta GetCurrentPresentation a cada ~400 ms (ETag evita tráfego quando nada mudou);
 * quando a apresentação muda, baixa a lista de slides uma vez e guarda em cache. */
'use strict';
const http = require('http');
const EventEmitter = require('events');

const SEM_TEXTO = new Set(['blank', 'black', 'wallpaper', 'final_slide']); // slide_type que não mostra letra
const COM_SLIDES = new Set(['song', 'text', 'quick_presentation', 'automatic_presentation']);

class Holyrics extends EventEmitter {
  /** getConfig() devolve config.holyrics: { host, port, token, ativo, intervalo } */
  constructor(getConfig) {
    super();
    this.getConfig = getConfig;
    this.timer = null;
    this.estado = 'desligado'; // desligado | conectando | conectado | erro
    this.erro = '';
    this.atual = null;         // { id, type, name, slide, total, slideType }
    this.texto = '';
    this.titulo = '';
    this.cache = { id: null, slides: [] };
    this.etag = '';
    this.falhas = 0;
    this.ultimo = '';          // assinatura do último texto emitido
  }

  start() { this.schedule(0); }

  /** Chamado quando a configuração muda: zera o cache e consulta de novo. */
  aplicarConfig() { this.etag = ''; this.cache = { id: null, slides: [] }; this.falhas = 0; this.schedule(0); }

  schedule(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.loop(), ms); }

  async loop() {
    const c = this.getConfig() || {};
    if (!c.ativo || !c.host) {
      if (this.estado !== 'desligado') { this.estado = 'desligado'; this.erro = ''; this.setAtual(null, '', ''); }
      return this.schedule(1000);
    }
    if (this.estado === 'desligado') { this.estado = 'conectando'; this.emitState(); }
    try {
      const r = await this.call('GetCurrentPresentation', {}, true);
      this.falhas = 0;
      if (this.estado !== 'conectado') { this.estado = 'conectado'; this.erro = ''; this.emitState(); }
      if (!r.unchanged) await this.processar(r.data);
      this.schedule(Math.max(200, Number(c.intervalo) || 400));
    } catch (e) {
      this.falhas++;
      const msg = String(e.message || e);
      if (this.estado !== 'erro' || this.erro !== msg) { this.estado = 'erro'; this.erro = msg; this.emitState(); }
      if (this.falhas === 1) console.warn('[holyrics] falha:', msg);
      this.setAtual(null, '', '');
      this.schedule(Math.min(10000, 2000 * this.falhas));
    }
  }

  async processar(d) {
    if (!d || !d.id) return this.setAtual(null, '', '');
    const atual = { id: String(d.id), type: d.type || '', name: d.name || '', slide: Number(d.slide_number) || 0, total: Number(d.total_slides) || 0, slideType: d.slide_type || 'default' };
    let texto = '', titulo = '';
    if (SEM_TEXTO.has(atual.slideType)) {
      // tela limpa / preta / papel de parede: letra sai da live
    } else if (COM_SLIDES.has(atual.type)) {
      if (this.cache.id !== atual.id) {
        const r = await this.call('GetCurrentPresentation', { include_slides: true }, false);
        this.cache = { id: atual.id, slides: (r.data && Array.isArray(r.data.slides)) ? r.data.slides : [] };
      }
      const s = this.cache.slides.find((x) => Number(x.number) === atual.slide) || this.cache.slides[atual.slide - 1];
      texto = s ? String(s.text || '') : '';
      titulo = atual.type === 'song' ? atual.name : '';
    } else if (atual.type === 'verse') {
      // a API não entrega a lista de slides de versículo; usa o que vier no item (referência no nome)
      texto = String(d.text || d.verse_text || '');
      titulo = atual.name;
    }
    this.setAtual(atual, texto.trim(), titulo.trim());
  }

  setAtual(atual, texto, titulo) {
    const sig = JSON.stringify([atual && atual.id, atual && atual.slide, texto, titulo]);
    this.atual = atual; this.texto = texto; this.titulo = titulo;
    if (sig !== this.ultimo) { this.ultimo = sig; this.emit('texto', this.state()); }
    this.emitState();
  }

  /** POST http://host:port/api/{action}?token=... com JSON. useEtag: envia If-None-Match e aceita 304. */
  call(action, body, useEtag) {
    const c = this.getConfig() || {};
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body || {});
      const req = http.request({
        host: c.host, port: Number(c.port) || 8091, method: 'POST',
        path: `/api/${action}?token=${encodeURIComponent(c.token || '')}`,
        headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, (useEtag && this.etag) ? { 'If-None-Match': this.etag } : {}),
        timeout: 3000,
      }, (res) => {
        if (res.statusCode === 304) { res.resume(); return resolve({ unchanged: true }); }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (ch) => { buf += ch; });
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('Token recusado pelo Holyrics'));
          let j; try { j = JSON.parse(buf); } catch { return reject(new Error(`Resposta inválida (HTTP ${res.statusCode}). É o endereço do Holyrics?`)); }
          if (j.status !== 'ok') return reject(new Error(this.traduzErro(j.error)));
          if (useEtag && res.headers.etag) this.etag = res.headers.etag;
          resolve({ data: j.data === undefined ? null : j.data });
        });
      });
      req.on('timeout', () => { req.destroy(new Error('Sem resposta do Holyrics (tempo esgotado)')); });
      req.on('error', (e) => {
        const m = { ECONNREFUSED: 'Holyrics não aceitou a conexão. O API Server está ativado?', EHOSTUNREACH: 'Computador do Holyrics não encontrado na rede', ENOTFOUND: 'Endereço não encontrado', ETIMEDOUT: 'Sem resposta do Holyrics (tempo esgotado)' };
        reject(new Error(m[e.code] || e.message));
      });
      req.end(data);
    });
  }

  traduzErro(err) {
    const e = String(err || 'erro desconhecido');
    if (/invalid token/i.test(e)) return 'Token inválido. Crie um token em Configurações → API Server → gerenciar permissões';
    if (/permission/i.test(e)) return 'O token não tem permissão para GetCurrentPresentation';
    return 'Holyrics respondeu: ' + e;
  }

  /** Testa um endereço/token sem alterar a configuração em uso. */
  static testar({ host, port, token }) {
    const h = new Holyrics(() => ({ host, port, token }));
    return h.call('GetCurrentPresentation', {}, false).then((r) => ({ ok: true, apresentando: !!(r.data && r.data.id), nome: r.data ? (r.data.name || '') : '' }));
  }

  state() {
    return { estado: this.estado, erro: this.erro, atual: this.atual, texto: this.texto, titulo: this.titulo };
  }

  emitState() {
    clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => this.emit('state', this.state()), 100);
  }
}

module.exports = { Holyrics };
