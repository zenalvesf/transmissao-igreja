/* Multidestino: o OBS transmite uma vez para este programa (RTMP local) e cada destino
 * (YouTube, Instagram, ...) recebe uma cópia, reenviada por um processo ffmpeg próprio que
 * reinicia sozinho se cair. O Instagram pode receber um recorte vertical 9:16. */
'use strict';
const { spawn, execFileSync } = require('child_process');
const EventEmitter = require('events');
const NodeMediaServer = require('node-media-server');

let FFMPEG = '';
try { FFMPEG = require('ffmpeg-static').replace('app.asar' + require('path').sep, 'app.asar.unpacked' + require('path').sep); } catch { FFMPEG = 'ffmpeg'; }

const STREAM_PATH = '/live/obs';
const ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'];
const ENC_ARGS = {
  h264_nvenc: ['-preset', 'p4', '-tune', 'll', '-rc', 'cbr', '-profile:v', 'main'],
  h264_qsv: ['-preset', 'veryfast', '-profile:v', 'main'],
  h264_amf: ['-quality', 'speed', '-rc', 'cbr', '-profile:v', 'main'],
  libx264: ['-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main'],
};

class Relay extends EventEmitter {
  /** getConfig() devolve config.relay: { rtmpPort, encoder, destinos: [...] } */
  constructor(getConfig) {
    super();
    this.getConfig = getConfig;
    this.nms = null;
    this.live = false;            // OBS está publicando em /live/obs
    this.procs = new Map();       // id do destino -> { child, timer, startedAt, lines, tentativas }
    this.status = new Map();      // id -> { estado, kbps, fps, tempo, erro, tentativas, encoder }
    this.sigs = new Map();        // id -> assinatura da configuração com que o envio foi iniciado
    this.available = this.probeEncoders();
    this.encIdx = 0;              // índice em this.available para o modo vertical (avança se falhar)
    this.ffmpegOk = !!this.available.length;
  }

  probeEncoders() {
    try {
      const out = execFileSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return ENCODERS.filter((e) => new RegExp(`\\s${e}\\s`).test(out));
    } catch (e) {
      console.error('[relay] ffmpeg não encontrado:', e.message);
      return [];
    }
  }

  get rtmpUrl() { return `rtmp://127.0.0.1:${this.getConfig().rtmpPort || 1935}/live`; }

  start() {
    const port = this.getConfig().rtmpPort || 1935;
    this.nms = new NodeMediaServer({ logType: 1, rtmp: { port, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 } });
    this.nms.on('postPublish', (id, StreamPath) => {
      if (StreamPath !== STREAM_PATH) return;
      console.log('[relay] OBS começou a transmitir');
      this.live = true;
      this.startAll();
      this.emitState();
    });
    this.nms.on('donePublish', (id, StreamPath) => {
      if (StreamPath !== STREAM_PATH) return;
      console.log('[relay] OBS parou de transmitir');
      this.live = false;
      this.stopAll();
      this.emitState();
    });
    try { this.nms.run(); console.log(`[relay] recebendo do OBS em ${this.rtmpUrl}/obs`); }
    catch (e) { console.error('[relay] não iniciou o servidor RTMP:', e.message); }
    this.emitState();
  }

  destinos() { return (this.getConfig().destinos || []).filter((d) => d && d.id); }

  startAll() { for (const d of this.destinos()) if (d.ativo) this.startDest(d.id); }
  stopAll() { for (const id of [...this.procs.keys()]) this.stopDest(id); }

  /** Chamado quando a configuração muda: liga/desliga/reinicia o que for preciso. */
  applyConfig() {
    const ids = new Set(this.destinos().filter((d) => d.ativo).map((d) => d.id));
    for (const id of [...this.procs.keys()]) if (!ids.has(id)) this.stopDest(id);
    for (const id of this.status.keys()) if (!this.destinos().some((d) => d.id === id)) this.status.delete(id);
    if (this.live) {
      // só reinicia o que mudou de verdade, para não derrubar um envio que está bem no ar
      for (const d of this.destinos()) {
        if (!d.ativo) continue;
        const sig = this.signature(d);
        if (!this.procs.has(d.id)) this.startDest(d.id);
        else if (this.sigs.get(d.id) !== sig) this.restartDest(d.id);
      }
    }
    this.emitState();
  }

  signature(d) {
    return JSON.stringify([d.url, d.key, d.modo, d.cropX, d.res, d.bitrate, d.modo === 'vertical' ? this.getConfig().encoder : '']);
  }

  restartDest(id) { this.stopDest(id); if (this.live) this.startDest(id); }

  pickEncoder() {
    const pref = this.getConfig().encoder;
    if (pref && pref !== 'auto' && this.available.includes(pref)) return pref;
    return this.available[Math.min(this.encIdx, this.available.length - 1)] || 'libx264';
  }

  buildArgs(d, encoder) {
    const out = String(d.url || '').replace(/\/+$/, '') + '/' + String(d.key || '');
    const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1',
      '-i', `${this.rtmpUrl}/obs`];
    if (d.modo === 'vertical') {
      const res = Number(d.res) === 1080 ? [1080, 1920] : [720, 1280];
      const x = Math.min(1, Math.max(0, Number(d.cropX ?? 0.5)));
      const kb = Math.max(800, Number(d.bitrate) || 2500);
      // redimensiona para a altura de saída e recorta uma faixa 9:16 (posição ajustável): pixels exatos, sem distorção
      const vf = `scale=-2:${res[1]}:flags=bicubic,crop=w=min(iw\\,${res[0]}):h=${res[1]}:x=(iw-ow)*${x}:y=0,pad=${res[0]}:${res[1]}:(ow-iw)/2:0,setsar=1,format=yuv420p`;
      args.push('-vf', vf, '-c:v', encoder, ...ENC_ARGS[encoder], '-b:v', `${kb}k`, '-maxrate', `${kb}k`, '-bufsize', `${kb * 2}k`, '-g', '60', '-c:a', 'copy');
    } else {
      args.push('-c', 'copy');
    }
    args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', out);
    return args;
  }

  startDest(id) {
    const d = this.destinos().find((x) => x.id === id);
    if (!d || this.procs.has(id)) return;
    if (!this.ffmpegOk) { this.setStatus(id, { estado: 'erro', erro: 'ffmpeg não encontrado' }); return; }
    if (!d.url || !d.key) { this.setStatus(id, { estado: 'erro', erro: 'Falta o endereço ou a chave da transmissão' }); return; }
    const encoder = d.modo === 'vertical' ? this.pickEncoder() : '';
    const prev = this.status.get(id) || {};
    const p = { child: null, timer: null, startedAt: Date.now(), lines: [], tentativas: prev.tentativas || 0, gotFrames: false, encoder };
    this.procs.set(id, p);
    this.sigs.set(id, this.signature(d));
    const args = this.buildArgs(d, encoder);
    console.log(`[relay] ${d.nome || id}: iniciando${encoder ? ' (' + encoder + ')' : ''}`);
    let child;
    try { child = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { this.procs.delete(id); this.setStatus(id, { estado: 'erro', erro: e.message }); return; }
    p.child = child;
    this.setStatus(id, { estado: 'conectando', kbps: 0, fps: 0, tempo: '', erro: '', tentativas: p.tentativas, encoder });

    let buf = '';
    const prog = {};
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const eq = line.indexOf('='); if (eq < 0) continue;
        prog[line.slice(0, eq)] = line.slice(eq + 1).trim();
        if (line.startsWith('progress=')) {
          const kbps = parseFloat(prog.bitrate) || 0;
          if (kbps > 0) { p.gotFrames = true; p.tentativas = 0; }
          this.setStatus(id, { estado: p.gotFrames ? 'no ar' : 'conectando', kbps: Math.round(kbps), fps: Math.round(parseFloat(prog.fps) || 0), tempo: (prog.out_time || '').split('.')[0], tentativas: p.tentativas });
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      for (const l of String(chunk).split(/\r?\n/)) if (l.trim()) { p.lines.push(l.trim()); if (p.lines.length > 30) p.lines.shift(); }
    });
    child.on('exit', (code) => {
      if (this.procs.get(id) !== p) return; // já foi parado/substituído
      this.procs.delete(id);
      const ran = Date.now() - p.startedAt;
      const lastErr = p.lines.filter((l) => !/^\s*$/.test(l)).slice(-2).join(' | ');
      this.setStatus(id, { log: p.lines.slice(-10) }); // guarda as últimas mensagens para o botão "Ver log"
      if (!this.live || !this.destinos().find((x) => x.id === id && x.ativo)) { this.setStatus(id, { estado: 'parado', kbps: 0, fps: 0, tempo: '' }); return; }
      // codificador por hardware que não existe nesta máquina: passa para o próximo
      if (encoder && !p.gotFrames && ran < 15000 && this.getConfig().encoder !== encoder && this.encIdx < this.available.length - 1) {
        console.warn(`[relay] ${encoder} falhou (${lastErr}); tentando o próximo codificador`);
        this.encIdx++;
        setTimeout(() => { if (this.live) this.startDest(id); }, 500);
        return;
      }
      p.tentativas++;
      const wait = Math.min(30000, 3000 * p.tentativas);
      console.warn(`[relay] ${d.nome || id} caiu (código ${code}) ${lastErr}; nova tentativa em ${wait / 1000}s`);
      this.setStatus(id, { estado: 'reiniciando', kbps: 0, fps: 0, erro: lastErr, tentativas: p.tentativas });
      const timer = setTimeout(() => { if (this.live) this.startDest(id); }, wait);
      this.procs.set(id, { child: null, timer, startedAt: 0, lines: p.lines, tentativas: p.tentativas, gotFrames: false, encoder });
    });
  }

  stopDest(id) {
    const p = this.procs.get(id);
    if (!p) return;
    this.procs.delete(id);
    clearTimeout(p.timer);
    if (p.child) { try { p.child.kill(); } catch { /* ignorar */ } }
    this.setStatus(id, { estado: 'parado', kbps: 0, fps: 0, tempo: '' });
  }

  setStatus(id, patch) {
    const cur = this.status.get(id) || { estado: 'parado', kbps: 0, fps: 0, tempo: '', erro: '', tentativas: 0 };
    this.status.set(id, Object.assign(cur, patch));
    this.emitState();
  }

  logOf(id) { const p = this.procs.get(id); return (p && p.lines.length) ? p.lines : ((this.status.get(id) || {}).log || []); }

  state() {
    const destinos = {};
    for (const d of this.destinos()) destinos[d.id] = Object.assign({ estado: 'parado', kbps: 0, fps: 0, tempo: '', erro: '', tentativas: 0 }, this.status.get(d.id) || {});
    return { live: this.live, rtmpUrl: this.rtmpUrl, streamKey: 'obs', ffmpegOk: this.ffmpegOk, encoders: this.available, encoder: this.pickEncoder(), destinos };
  }

  emitState() {
    clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => this.emit('state', this.state()), 150);
  }
}

module.exports = { Relay, FFMPEG };
