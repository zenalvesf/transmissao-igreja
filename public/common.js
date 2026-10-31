/* Utilidades compartilhadas: WebSocket com reconexão automática e helpers */
(function () {
  'use strict';

  /**
   * WebSocket que reconecta sozinho e reenvia o "hello" ao voltar.
   * Uso: const hub = new Hub({ role: 'cam', name: 'Celular 1', meta: {...} }, onMessage, onStatus)
   */
  class Hub {
    constructor(hello, onMessage, onStatus) {
      this.hello = hello;
      this.onMessage = onMessage || (() => {});
      this.onStatus = onStatus || (() => {});
      this.ws = null;
      this.id = null;
      this.stun = [];
      this.attempt = 0;
      this.closed = false;
      this.pingTimer = null;
      this.connect();
    }
    url() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}/ws`;
    }
    connect() {
      if (this.closed) return;
      this.onStatus('connecting');
      let ws;
      try { ws = new WebSocket(this.url()); } catch (e) { return this.scheduleReconnect(); }
      this.ws = ws;
      ws.onopen = () => {
        this.attempt = 0;
        ws.send(JSON.stringify(Object.assign({ type: 'hello' }, this.hello)));
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send({ type: 'ping', t: Date.now() }), 10000);
      };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'welcome') { this.id = m.id; this.stun = m.stun || []; this.onStatus('online'); }
        this.onMessage(m);
      };
      ws.onclose = () => { clearInterval(this.pingTimer); if (this.ws === ws) { this.ws = null; this.onStatus('offline'); this.scheduleReconnect(); } };
      ws.onerror = () => { try { ws.close(); } catch { /* ignorar */ } };
    }
    scheduleReconnect() {
      if (this.closed) return;
      const delay = Math.min(1000 * Math.pow(1.6, this.attempt++), 8000);
      setTimeout(() => this.connect(), delay);
    }
    send(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(obj)); return true; }
      return false;
    }
    setHello(patch) { Object.assign(this.hello, patch); }
    close() { this.closed = true; clearInterval(this.pingTimer); if (this.ws) this.ws.close(); }
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return [...(root || document).querySelectorAll(sel)]; }
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children || [])) if (c != null) e.append(c);
    return e;
  }
  function fmtBytes(bps) {
    if (!bps) return '0 kb/s';
    const kb = bps / 1000;
    return kb >= 1000 ? (kb / 1000).toFixed(1) + ' Mb/s' : Math.round(kb) + ' kb/s';
  }
  function iceConfig(stun) {
    return { iceServers: (stun || []).length ? [{ urls: stun }] : [], bundlePolicy: 'max-bundle' };
  }

  window.TI = { Hub, $, $$, el, fmtBytes, iceConfig };
})();
