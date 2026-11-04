/* Player de vídeos com playlist, usando uma fonte de mídia do OBS:
 * - cena "Vídeo" com a fonte "Player (vídeo)" (ffmpeg_source), criada na hora se não existir
 * - tocar troca o arquivo da fonte, corta para a cena e acompanha o progresso (GetMediaInputStatus)
 * - ao terminar (MediaInputPlaybackEnded): volta para a cena anterior, toca o próximo ou repete a lista
 * - opcionalmente silencia os microfones enquanto o vídeo toca */
'use strict';
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const FIM = ['voltar', 'proximo', 'repetir'];

class Player extends EventEmitter {
  /** obs: cliente obs-websocket com call(); getConfig(): config.player; arquivo: playlist.json */
  constructor(obs, getConfig, arquivo) {
    super();
    this.obs = obs; this.getConfig = getConfig; this.arquivo = arquivo;
    let salvo = {}; try { salvo = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { /* primeira vez */ }
    this.itens = Array.isArray(salvo.itens) ? salvo.itens.filter((i) => i && i.arquivo) : [];
    this.aoTerminar = FIM.includes(salvo.aoTerminar) ? salvo.aoTerminar : 'voltar';
    this.silenciarMics = !!salvo.silenciarMics;
    this.volume = Math.max(0, Math.min(100, Number(salvo.volume) || 100));
    this.nextId = this.itens.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0) + 1;
    this.tocando = false; this.pausado = false; this.atual = -1; this.cenaAnterior = '';
    this.status = { cursor: 0, duracao: 0, estado: '' };
    this.micsSilenciados = []; // microfones que o player silenciou (para devolver depois)
    this.erro = '';
    this.timer = null; this.conectado = false;
  }

  cfg() { return Object.assign({ cena: 'Vídeo', fonte: 'Player (vídeo)' }, this.getConfig() || {}); }
  salvar() {
    try { fs.mkdirSync(path.dirname(this.arquivo), { recursive: true }); fs.writeFileSync(this.arquivo, JSON.stringify({ itens: this.itens, aoTerminar: this.aoTerminar, silenciarMics: this.silenciarMics, volume: this.volume }, null, 2)); }
    catch (e) { console.warn('[player] não salvou a playlist:', e.message); }
  }

  // ---- ligações com o OBS (chamadas pelo servidor)
  onConnected() { this.conectado = true; this.emitState(); }
  onDisconnected() { this.conectado = false; this.pararPolling(); this.tocando = false; this.pausado = false; this.emitState(); }
  onEvent(tipo, d) {
    const c = this.cfg();
    if (tipo === 'MediaInputPlaybackEnded') { if (this.tocando && d.inputName === c.fonte) this.fimDoVideo().catch((e) => console.warn('[player]', e.message)); }
    else if (tipo === 'CurrentProgramSceneChanged') {
      // o operador cortou para outra cena no meio do vídeo: o player para sem mexer na cena
      if (this.tocando && d.sceneName !== c.cena) { this.pararPolling(); this.tocando = false; this.pausado = false; this.devolverMics().catch(() => {}); this.emitState(); }
    }
  }

  // ---- playlist
  adicionar({ nome, arquivo, origem }) {
    arquivo = String(arquivo || '').trim().replace(/^"|"$/g, '');
    if (!arquivo) throw new Error('Informe o arquivo do vídeo');
    if (!fs.existsSync(arquivo)) throw new Error('Arquivo não encontrado neste computador: ' + arquivo);
    const item = { id: this.nextId++, nome: String(nome || path.basename(arquivo)).trim().slice(0, 80) || path.basename(arquivo), arquivo, origem: origem === 'upload' ? 'upload' : 'caminho' };
    this.itens.push(item); this.salvar(); this.emitState();
    return item;
  }
  remover(id) {
    const i = this.itens.findIndex((x) => x.id === Number(id)); if (i < 0) return false;
    const [item] = this.itens.splice(i, 1);
    if (item.origem === 'upload') { try { fs.unlinkSync(item.arquivo); } catch { /* já não existe */ } }
    if (this.atual === i) this.atual = -1; else if (this.atual > i) this.atual--;
    this.salvar(); this.emitState(); return true;
  }
  mover(id, dir) {
    const i = this.itens.findIndex((x) => x.id === Number(id)), j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= this.itens.length) return false;
    [this.itens[i], this.itens[j]] = [this.itens[j], this.itens[i]];
    if (this.atual === i) this.atual = j; else if (this.atual === j) this.atual = i;
    this.salvar(); this.emitState(); return true;
  }
  async setOpcoes({ aoTerminar, silenciarMics, volume }) {
    if (FIM.includes(aoTerminar)) this.aoTerminar = aoTerminar;
    if (silenciarMics !== undefined) this.silenciarMics = !!silenciarMics;
    if (volume !== undefined) {
      this.volume = Math.max(0, Math.min(100, Number(volume) || 0));
      if (this.tocando) await this.obs.call('SetInputVolume', { inputName: this.cfg().fonte, inputVolumeMul: this.volume / 100 }).catch(() => {});
    }
    this.salvar(); this.emitState();
  }

  // ---- reprodução
  async tocar(id) {
    const idx = id === undefined ? (this.atual >= 0 ? this.atual : 0) : this.itens.findIndex((x) => x.id === Number(id));
    const item = this.itens[idx];
    if (!item) throw new Error('Vídeo não está na lista');
    if (!fs.existsSync(item.arquivo)) throw new Error('Arquivo não encontrado: ' + item.arquivo);
    const c = this.cfg(), obs = this.obs;
    const cenas = (await obs.call('GetSceneList')).scenes.map((s) => s.sceneName);
    if (!cenas.includes(c.cena)) await obs.call('CreateScene', { sceneName: c.cena });
    const inputs = (await obs.call('GetInputList')).inputs.map((i) => i.inputName);
    const settings = { local_file: item.arquivo, is_local_file: true, looping: this.aoTerminar === 'repetir' && this.itens.length === 1, restart_on_activate: true, clear_on_media_end: false, close_when_inactive: true, hw_decode: true, speed_percent: 100 };
    if (!inputs.includes(c.fonte)) await obs.call('CreateInput', { sceneName: c.cena, inputName: c.fonte, inputKind: 'ffmpeg_source', inputSettings: settings });
    else await obs.call('SetInputSettings', { inputName: c.fonte, inputSettings: settings, overlay: true });
    try { // a fonte preenche a tela inteira
      const vs = await obs.call('GetVideoSettings');
      const sc = (await obs.call('GetSceneItemList', { sceneName: c.cena })).sceneItems.find((i) => i.sourceName === c.fonte);
      if (sc) await obs.call('SetSceneItemTransform', { sceneName: c.cena, sceneItemId: sc.sceneItemId, sceneItemTransform: { positionX: 0, positionY: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: vs.baseWidth, boundsHeight: vs.baseHeight } });
    } catch { /* sem ajuste de tamanho */ }
    await obs.call('SetInputVolume', { inputName: c.fonte, inputVolumeMul: this.volume / 100 }).catch(() => {});
    if (this.silenciarMics) await this.silenciarMicrofones().catch(() => {});
    const cur = (await obs.call('GetCurrentProgramScene')).currentProgramSceneName;
    if (cur !== c.cena) this.cenaAnterior = cur;
    await obs.call('SetCurrentProgramScene', { sceneName: c.cena });
    await obs.call('TriggerMediaInputAction', { inputName: c.fonte, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }).catch(() => {});
    this.tocando = true; this.pausado = false; this.atual = idx; this.erro = '';
    this.status = { cursor: 0, duracao: 0, estado: 'playing' };
    this.iniciarPolling();
    this.emitState();
    return item;
  }
  async pausar() {
    if (!this.tocando) return;
    await this.obs.call('TriggerMediaInputAction', { inputName: this.cfg().fonte, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' });
    this.pausado = true; this.emitState();
  }
  async continuar() {
    if (!this.tocando) return this.tocar();
    await this.obs.call('TriggerMediaInputAction', { inputName: this.cfg().fonte, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' });
    this.pausado = false; this.emitState();
  }
  /** Para o vídeo e volta para a cena de antes. */
  async parar() {
    this.pararPolling();
    const estava = this.tocando, anterior = this.cenaAnterior, c = this.cfg();
    this.tocando = false; this.pausado = false; this.emitState();
    if (estava) await this.obs.call('TriggerMediaInputAction', { inputName: c.fonte, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }).catch(() => {});
    await this.devolverMics().catch(() => {});
    if (estava && anterior) await this.obs.call('SetCurrentProgramScene', { sceneName: anterior });
  }
  async proximo() {
    if (!this.itens.length) return;
    let idx = this.atual + 1;
    if (idx >= this.itens.length) { if (this.aoTerminar === 'repetir') idx = 0; else return this.parar(); }
    const anterior = this.cenaAnterior; // mantém a cena de antes da lista inteira
    await this.tocar(this.itens[idx].id);
    this.cenaAnterior = anterior || this.cenaAnterior;
  }
  async fimDoVideo() {
    if (this.aoTerminar === 'voltar') return this.parar();
    if (this.aoTerminar === 'proximo' && this.atual + 1 >= this.itens.length) return this.parar();
    return this.proximo();
  }

  // ---- microfones
  async silenciarMicrofones() {
    const inputs = (await this.obs.call('GetInputList')).inputs.filter((i) => i.inputKind === 'wasapi_input_capture');
    this.micsSilenciados = [];
    for (const i of inputs) {
      try {
        const m = await this.obs.call('GetInputMute', { inputName: i.inputName });
        if (!m.inputMuted) { await this.obs.call('SetInputMute', { inputName: i.inputName, inputMuted: true }); this.micsSilenciados.push(i.inputName); }
      } catch { /* fonte sem áudio */ }
    }
  }
  async devolverMics() {
    const lista = this.micsSilenciados.splice(0);
    for (const nome of lista) await this.obs.call('SetInputMute', { inputName: nome, inputMuted: false }).catch(() => {});
  }

  // ---- progresso
  iniciarPolling() {
    this.pararPolling();
    this.timer = setInterval(async () => {
      if (!this.tocando) return this.pararPolling();
      try {
        const s = await this.obs.call('GetMediaInputStatus', { inputName: this.cfg().fonte });
        this.status = { cursor: Number(s.mediaCursor) || 0, duracao: Number(s.mediaDuration) || 0, estado: String(s.mediaState || '').replace('OBS_MEDIA_STATE_', '').toLowerCase() };
        if (this.status.estado === 'paused' && !this.pausado) this.pausado = true;
        if (this.status.estado === 'playing' && this.pausado) this.pausado = false;
        this.emit('state', this.state());
      } catch { /* OBS ocupado */ }
    }, 500);
  }
  pararPolling() { clearInterval(this.timer); this.timer = null; }

  state() {
    return {
      conectado: this.conectado, tocando: this.tocando, pausado: this.pausado, atual: this.atual, item: this.itens[this.atual] || null,
      cenaAnterior: this.cenaAnterior, status: this.status, erro: this.erro,
      itens: this.itens, aoTerminar: this.aoTerminar, silenciarMics: this.silenciarMics, volume: this.volume,
      cena: this.cfg().cena, fonte: this.cfg().fonte,
    };
  }
  emitState() { clearTimeout(this._t); this._t = setTimeout(() => this.emit('state', this.state()), 60); }
}

module.exports = { Player };
