/* Replay instantâneo usando o "buffer de replay" do próprio OBS:
 * - o OBS guarda os últimos N segundos do programa na memória (StartReplayBuffer)
 * - "Salvar" grava esses segundos num arquivo (SaveReplayBuffer -> evento ReplayBufferSaved)
 * - "Exibir" coloca o arquivo numa fonte de mídia na cena "Replay", corta para ela e volta
 *   sozinho para a cena anterior quando o vídeo termina (MediaInputPlaybackEnded). */
'use strict';
const path = require('path');
const EventEmitter = require('events');

class Replay extends EventEmitter {
  /** obs: cliente obs-websocket com call(); getConfig(): config.replay */
  constructor(obs, getConfig) {
    super();
    this.obs = obs; this.getConfig = getConfig;
    this.bufferAtivo = false;
    this.erro = '';            // última falha (ex.: replay não ativado no OBS)
    this.salvos = [];          // [{ arquivo, nome, hora }], mais recente primeiro
    this.exibindo = false; this.arquivoExibido = ''; this.cenaAnterior = '';
    this.esperandoSalvar = []; // promessas aguardando ReplayBufferSaved
    this.timerVoltar = null;
    this.ligando = false;
  }

  cfg() { return Object.assign({ auto: true, segundos: 30, velocidade: 100, cena: 'Replay', fonte: 'Replay (vídeo)' }, this.getConfig() || {}); }

  // ---- ligações com o OBS (chamadas pelo servidor)
  async onConnected() {
    await this.refresh();
    if (this.cfg().auto && !this.bufferAtivo) await this.ligar(true);
  }
  onDisconnected() { this.bufferAtivo = false; this.exibindo = false; this.emitState(); }
  onEvent(tipo, d) {
    if (tipo === 'ReplayBufferStateChanged') { this.bufferAtivo = !!d.outputActive; if (this.bufferAtivo) this.erro = ''; this.emitState(); }
    else if (tipo === 'ReplayBufferSaved') {
      const arquivo = d.savedReplayPath || '';
      const item = { arquivo, nome: path.basename(arquivo), hora: new Date().toTimeString().slice(0, 8) };
      this.salvos.unshift(item); this.salvos = this.salvos.slice(0, 30);
      for (const r of this.esperandoSalvar.splice(0)) r(item);
      this.emitState();
    } else if (tipo === 'MediaInputPlaybackEnded') {
      if (this.exibindo && d.inputName === this.cfg().fonte) this.voltar().catch(() => {});
    } else if (tipo === 'CurrentProgramSceneChanged') {
      if (this.exibindo && d.sceneName !== this.cfg().cena) { this.exibindo = false; clearTimeout(this.timerVoltar); this.emitState(); }
    }
  }

  async refresh() {
    try { const r = await this.obs.call('GetReplayBufferStatus'); this.bufferAtivo = !!r.outputActive; }
    catch (e) { this.bufferAtivo = false; this.erro = this.traduz(e); }
    this.emitState();
  }

  /** Liga o buffer. O OBS ignora o pedido em silêncio quando o replay não está ativado nas configurações;
   *  por isso confere o estado logo depois. */
  async ligar(silencioso) {
    if (this.ligando) return;
    this.ligando = true;
    try {
      await this.obs.call('StartReplayBuffer');
      await new Promise((r) => setTimeout(r, 1500));
      const r = await this.obs.call('GetReplayBufferStatus');
      this.bufferAtivo = !!r.outputActive;
      this.erro = this.bufferAtivo ? '' : 'O replay não está ativado nas configurações do OBS (Saída → Buffer de replay).';
      if (!this.bufferAtivo && !silencioso) throw new Error(this.erro);
    } catch (e) {
      this.erro = this.traduz(e);
      if (!silencioso) throw new Error(this.erro);
    } finally { this.ligando = false; this.emitState(); }
  }

  async desligar() { await this.obs.call('StopReplayBuffer'); }

  /** Pede ao OBS para gravar os últimos segundos; devolve o item salvo (ou erro após 15 s). */
  async salvar() {
    if (!this.bufferAtivo) throw new Error(this.erro || 'O buffer de replay está desligado');
    const esperado = new Promise((resolve, reject) => {
      this.esperandoSalvar.push(resolve);
      setTimeout(() => { const i = this.esperandoSalvar.indexOf(resolve); if (i >= 0) { this.esperandoSalvar.splice(i, 1); reject(new Error('O OBS não confirmou o replay salvo')); } }, 15000);
    });
    await this.obs.call('SaveReplayBuffer');
    return esperado;
  }

  /** Mostra um replay no programa: prepara a cena/fonte, corta para ela e agenda a volta. */
  async exibir(arquivo, velocidade) {
    const c = this.cfg();
    arquivo = arquivo || (this.salvos[0] && this.salvos[0].arquivo);
    if (!arquivo) throw new Error('Nenhum replay salvo ainda');
    const vel = Math.min(200, Math.max(25, Number(velocidade) || c.velocidade || 100));
    const obs = this.obs;
    const cenas = (await obs.call('GetSceneList')).scenes.map((s) => s.sceneName);
    if (!cenas.includes(c.cena)) await obs.call('CreateScene', { sceneName: c.cena });
    const inputs = (await obs.call('GetInputList')).inputs.map((i) => i.inputName);
    const settings = { local_file: arquivo, is_local_file: true, looping: false, restart_on_activate: true, clear_on_media_end: false, close_when_inactive: true, speed_percent: vel };
    if (!inputs.includes(c.fonte)) await obs.call('CreateInput', { sceneName: c.cena, inputName: c.fonte, inputKind: 'ffmpeg_source', inputSettings: settings });
    else await obs.call('SetInputSettings', { inputName: c.fonte, inputSettings: settings, overlay: true });
    // a fonte preenche a tela inteira
    try {
      const vs = await obs.call('GetVideoSettings');
      const item = (await obs.call('GetSceneItemList', { sceneName: c.cena })).sceneItems.find((i) => i.sourceName === c.fonte);
      if (item) await obs.call('SetSceneItemTransform', { sceneName: c.cena, sceneItemId: item.sceneItemId, sceneItemTransform: { positionX: 0, positionY: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: vs.baseWidth, boundsHeight: vs.baseHeight } });
    } catch { /* sem ajuste de tamanho */ }
    const cur = (await obs.call('GetCurrentProgramScene')).currentProgramSceneName;
    if (cur !== c.cena) this.cenaAnterior = cur;
    await obs.call('SetCurrentProgramScene', { sceneName: c.cena });
    await obs.call('TriggerMediaInputAction', { inputName: c.fonte, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }).catch(() => {});
    this.exibindo = true; this.arquivoExibido = arquivo;
    // segurança: se o OBS não avisar o fim do vídeo, volta pela duração esperada
    clearTimeout(this.timerVoltar);
    this.timerVoltar = setTimeout(() => { if (this.exibindo) this.voltar().catch(() => {}); }, (Number(c.segundos) || 30) * 1000 * (100 / vel) + 4000);
    this.emitState();
  }

  async voltar() {
    clearTimeout(this.timerVoltar);
    const anterior = this.cenaAnterior;
    this.exibindo = false; this.emitState();
    if (anterior) await this.obs.call('SetCurrentProgramScene', { sceneName: anterior });
  }

  traduz(e) {
    const m = String((e && e.message) || e);
    if (/não conectado|not connected/i.test(m)) return 'OBS não conectado';
    if (/not (initialized|ready|available)|OutputNotReady|replay buffer/i.test(m)) return 'O replay não está ativado nas configurações do OBS (Saída → Buffer de replay).';
    return m;
  }

  state() {
    const c = this.cfg();
    return { bufferAtivo: this.bufferAtivo, erro: this.erro, salvos: this.salvos, exibindo: this.exibindo, arquivoExibido: this.arquivoExibido, cenaAnterior: this.cenaAnterior, segundos: c.segundos, velocidade: c.velocidade, auto: c.auto };
  }
  emitState() { clearTimeout(this._t); this._t = setTimeout(() => this.emit('state', this.state()), 80); }
}

module.exports = { Replay };
