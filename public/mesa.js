/* Mesa de produção: controla o OBS (via servidor), as legendas, o roteiro e os celulares */
(function () {
  'use strict';
  const { Hub, $, $$, el, fmtBytes } = window.TI;

  // ------------------------------------------------------------ estado
  const S = {
    obs: false, scenes: [], program: '', transitions: [], transition: '', transitionsFull: [], transitionDur: 300, transitionFixed: false,
    tsInfo: null, tsPend: { adicionar: [], remover: [] }, // transições na coleção do OBS e mudanças ainda não aplicadas
    imagens: [], // imagens enviadas (logo, fundos)
    player: null, // player de vídeos (playlist)
    streaming: false, recording: false, lastStreamBytes: 0, lastStreamTs: 0,
    overlay: {}, roteiro: { itens: [], atual: -1 }, presets: { legendas: [], versiculos: [], avisos: [] },
    cams: [], config: null, info: null, editing: false, audioInputs: [],
    tally: {}, // nome da câmera -> true/false
    relay: null, // estado do multidestino
    holyrics: null, // estado da conexão com o Holyrics
    replay: null, // estado do replay instantâneo
    traducao: null, trParcial: '', // tradução ao vivo
  };
  const pending = new Map(); let reqId = 1;

  // ------------------------------------------------------------ conexão com o servidor
  const hub = new Hub({ role: 'mesa' }, onMessage, (st) => {
    setBadge($('#srvBadge'), st === 'online' ? 'ok' : 'danger', 'Servidor');
  });

  function obs(request, data) {
    return new Promise((resolve, reject) => {
      const id = String(reqId++);
      pending.set(id, { resolve, reject });
      if (!hub.send({ type: 'obs', id, request, data })) { pending.delete(id); reject(new Error('Servidor offline')); }
      setTimeout(() => { if (pending.delete(id)) reject(new Error('Sem resposta')); }, 12000);
    });
  }
  function obsBatch(requests) {
    return new Promise((resolve, reject) => {
      const id = String(reqId++);
      pending.set(id, { resolve, reject });
      if (!hub.send({ type: 'obsBatch', id, requests })) { pending.delete(id); reject(new Error('Servidor offline')); }
      setTimeout(() => { if (pending.delete(id)) reject(new Error('Sem resposta')); }, 30000);
    });
  }
  function overlayPatch(patch) { hub.send({ type: 'overlay', patch }); }
  function camControl(cam, cmd, value) { hub.send({ type: 'camControl', cam, cmd, value }); }

  function onMessage(m) {
    switch (m.type) {
      case 'welcome': loadInfo(); break;
      case 'obsResult': {
        const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
        m.ok ? p.resolve(m.data) : p.reject(new Error(m.error));
        break;
      }
      case 'obsStatus': S.obs = m.connected; refreshObsLocal(); if (m.connected) setTimeout(refreshRelayObs, 500); setBadge($('#obsBadge'), m.connected ? 'ok' : 'danger', 'OBS'); $('#cfgObsMsg').textContent = m.connected ? 'Conectado ✔' : (m.error ? 'Erro: ' + m.error : 'Desconectado'); if (m.connected) refreshObs(); break;
      case 'obsEvent': onObsEvent(m.event, m.data); break;
      case 'overlay': S.overlay = m.overlay; renderOverlayState(); break;
      case 'roteiro': S.roteiro = m.roteiro; renderRoteiro(); break;
      case 'presets': S.presets = m.presets; renderPresets(); break;
      case 'cams': S.cams = m.cams; renderCams(); updateTally(); break;
      case 'camStats': { const c = S.cams.find((x) => x.id === m.id); if (c) { c.meta = Object.assign({}, c.meta, m.stats); renderCams(); } break; }
      case 'config': S.config = m.config; renderConfig(); renderDests(); renderHolyConfig(); renderReplayConfig(); renderTrConfig(); renderGrConfig(); break;
      case 'relay': S.relay = m.state; renderRelay(); break;
      case 'holyrics': S.holyrics = m.state; renderHoly(); break;
      case 'replay': S.replay = m.state; renderReplay(); break;
      case 'player': S.player = m.state; renderPlayer(); break;
      case 'traducao': S.traducao = m.state; renderTr(); break;
      case 'traducaoParcial': S.trParcial = m.texto || ''; renderTrAgora(); break;
      default: break;
    }
  }

  async function loadInfo() {
    try { S.info = await (await fetch('/api/info')).json(); renderQr(); renderNet(); renderTrQr(); } catch { /* ignorar */ }
  }

  // ------------------------------------------------------------ OBS: cenas, programa, transição, status
  async function refreshObs() {
    try {
      const sl = await obs('GetSceneList');
      S.scenes = sl.scenes.sort((a, b) => b.sceneIndex - a.sceneIndex).map((s) => s.sceneName);
      S.program = sl.currentProgramSceneName;
      const tl = await obs('GetSceneTransitionList');
      S.transitionsFull = tl.transitions; S.transitions = tl.transitions.map((t) => t.transitionName); S.transition = tl.currentSceneTransitionName;
      await refreshTransitionInfo(false);
      renderScenes(); renderTransitions(); renderRoteiroSceneOptions();
      const st = await obs('GetStreamStatus'); applyStreamStatus(st);
      const rc = await obs('GetRecordStatus'); S.recording = rc.outputActive; renderRecord();
      refreshAudio();
      updateTally();
    } catch (e) { toast('OBS: ' + e.message, true); }
  }

  function onObsEvent(ev, d) {
    switch (ev) {
      case 'CurrentProgramSceneChanged': S.program = d.sceneName; renderScenes(); updateTally(); break;
      case 'SceneListChanged': case 'SceneCreated': case 'SceneRemoved': case 'SceneNameChanged': refreshObs(); if ($('#tab-telas').classList.contains('active')) setTimeout(refreshTelas, 300); break;
      case 'CurrentSceneTransitionChanged': S.transition = d.transitionName; refreshTransitionInfo(); break;
      case 'CurrentSceneTransitionDurationChanged': S.transitionDur = d.transitionDuration; renderTransitions(); break;
      case 'StreamStateChanged': S.streaming = d.outputActive; renderStream(); break;
      case 'RecordStateChanged': S.recording = d.outputActive; renderRecord(); break;
      case 'InputMuteStateChanged': { const i = S.audioInputs.find((x) => x.name === d.inputName); if (i) { i.muted = d.inputMuted; renderAudio(); } break; }
      case 'InputVolumeChanged': { const i = S.audioInputs.find((x) => x.name === d.inputName); if (i) { i.db = d.inputVolumeDb; renderAudio(); } break; }
      case 'InputCreated': case 'InputRemoved': case 'InputNameChanged': refreshAudio(); if ($('#tab-fontes').classList.contains('active')) refreshFontes(); break;
      default: break;
    }
  }

  function renderScenes() {
    const box = $('#scenes'); box.innerHTML = '';
    const visible = S.scenes.filter((n) => n !== 'Overlay' && !n.startsWith('_'));
    visible.forEach((name, i) => {
      const b = el('button', { class: name === S.program ? 'program' : '', onclick: (e) => setScene(name, e.shiftKey ? cutName() : '') }, [
        el('span', { text: name }),
        i < 9 ? el('span', { class: 'key', text: String(i + 1) }) : null,
        name === S.program ? el('span', { class: 'sub', text: 'NO AR' }) : null,
      ]);
      box.append(b);
    });
    if (!visible.length) box.append(el('p', { class: 'muted', text: S.obs ? 'Nenhuma cena no OBS.' : 'Conecte o OBS na aba Config.' }));
    $('#previewLabel').textContent = S.program || '';
  }
  /** Troca de cena. Com "trans" (e opcionalmente "dur"), usa essa transição só desta vez e devolve a padrão depois. */
  async function setScene(name, trans, dur) {
    try {
      const usar = trans && S.transitions.includes(trans) ? trans : '';
      if (!usar || (usar === S.transition && (!dur || Number(dur) === S.transitionDur))) return await obs('SetCurrentProgramScene', { sceneName: name });
      const antes = { nome: S.transition, dur: S.transitionDur };
      const reqs = [{ request: 'SetCurrentSceneTransition', data: { transitionName: usar } }];
      if (dur) reqs.push({ request: 'SetCurrentSceneTransitionDuration', data: { transitionDuration: Number(dur) } });
      reqs.push({ request: 'SetCurrentProgramScene', data: { sceneName: name } });
      const r = await obsBatch(reqs);
      const falha = r.find((x) => !x.ok); if (falha) throw new Error(falha.error);
      setTimeout(() => obsBatch([{ request: 'SetCurrentSceneTransition', data: { transitionName: antes.nome } }, { request: 'SetCurrentSceneTransitionDuration', data: { transitionDuration: antes.dur } }]).catch(() => {}), Math.max(300, Number(dur) || S.transitionDur) + 500);
    } catch (e) { toast('Não foi possível trocar: ' + e.message, true); }
  }
  function cutName() { const t = S.transitionsFull.find((x) => x.transitionKind === 'cut_transition'); return t ? t.transitionName : ''; }
  async function refreshTransitionInfo(render = true) {
    try { const ct = await obs('GetCurrentSceneTransition'); S.transitionDur = ct.transitionDuration || S.transitionDur; S.transitionFixed = !!ct.transitionFixed; } catch { /* OBS antigo */ }
    if (render) renderTransitions();
  }
  function renderTransitions() {
    const sel = $('#transition'); sel.innerHTML = '';
    for (const t of S.transitions) sel.append(el('option', { value: t, text: t, selected: t === S.transition }));
    const d = $('#transitionDur'); if (document.activeElement !== d) d.value = S.transitionDur; d.disabled = S.transitionFixed; d.title = S.transitionFixed ? 'Esta transição tem duração fixa' : 'Duração da transição em milissegundos';
    const box = $('#tsLista'); box.innerHTML = '';
    for (const t of S.transitionsFull) {
      const inp = el('input', { type: 'radio', name: 'tsAtual', value: t.transitionName, checked: t.transitionName === S.transition });
      inp.addEventListener('change', () => obs('SetCurrentSceneTransition', { transitionName: t.transitionName }).catch((e) => toast(e.message, true)));
      box.append(el('label', { class: 'ts-op' + (t.transitionName === S.transition ? ' on' : '') }, [inp, el('span', { text: t.transitionName }), el('span', { class: 'muted', text: tsKindLabel(t.transitionKind) })]));
    }
    if (!S.transitionsFull.length) box.append(el('p', { class: 'muted', text: S.obs ? 'Nenhuma transição no OBS.' : 'Conecte o OBS.' }));
    const r = $('#tsDur'); if (document.activeElement !== r) r.value = Math.min(3000, S.transitionDur); r.disabled = S.transitionFixed; $('#tsDurVal').textContent = S.transitionDur;
    const rt = $('#riTrans'); const cur = rt.value; rt.innerHTML = '<option value="">(a padrão)</option>';
    for (const t of S.transitions) rt.append(el('option', { value: t, text: t })); rt.value = cur;
  }
  const TS_KINDS = { cut_transition: 'corte', fade_transition: 'esmaecer', obs_stinger_transition: 'estinger', fade_to_color_transition: 'esmaecer para cor', slide_transition: 'deslizar', swipe_transition: 'varrer', wipe_transition: 'luma', scene_as_transition: 'cena' };
  function tsKindLabel(k) { return TS_KINDS[k] || k || ''; }
  $('#transition').addEventListener('change', (e) => obs('SetCurrentSceneTransition', { transitionName: e.target.value }).catch(() => {}));
  let durTimer = null;
  function setDur(v) { v = Math.max(50, Math.min(20000, Number(v) || 300)); S.transitionDur = v; $('#tsDurVal').textContent = v; clearTimeout(durTimer); durTimer = setTimeout(() => obs('SetCurrentSceneTransitionDuration', { transitionDuration: v }).catch((e) => toast(e.message, true)), 250); }
  $('#transitionDur').addEventListener('change', (e) => setDur(e.target.value));
  $('#tsDur').addEventListener('input', (e) => setDur(e.target.value));

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    const visible = S.scenes.filter((n) => n !== 'Overlay' && !n.startsWith('_'));
    const num = e.code && /^(Digit|Numpad)[1-9]$/.test(e.code) ? Number(e.code.slice(-1)) : (e.key >= '1' && e.key <= '9' ? Number(e.key) : 0);
    if (num && visible[num - 1]) setScene(visible[num - 1], e.shiftKey ? cutName() : '');
    if (e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); nextItem(1); }
    if (e.key === 'PageUp') { e.preventDefault(); nextItem(-1); }
    if (e.key === 'r' || e.key === 'R') rpSalvar();
  });

  // Prévia do programa + estatísticas
  setInterval(async () => {
    if (!S.obs || !S.program || document.hidden) return;
    try {
      const r = await obs('GetSourceScreenshot', { sourceName: S.program, imageFormat: 'jpg', imageWidth: 640, imageCompressionQuality: 55 });
      $('#preview').src = r.imageData;
    } catch { /* ignorar */ }
  }, 1500);
  setInterval(async () => {
    if (!S.obs) return;
    try {
      const st = await obs('GetStreamStatus'); applyStreamStatus(st);
      const s = await obs('GetStats');
      $('#statCpu').textContent = 'CPU ' + s.cpuUsage.toFixed(0) + '%';
      $('#statFps').textContent = s.activeFps.toFixed(0) + ' fps';
      $('#statDropped').textContent = 'quadros perdidos: ' + (s.outputSkippedFrames || 0) + ' / render ' + (s.renderSkippedFrames || 0);
    } catch { /* ignorar */ }
  }, 2000);

  function applyStreamStatus(st) {
    S.streaming = st.outputActive;
    const now = Date.now();
    let bps = 0;
    if (S.lastStreamTs && st.outputBytes >= S.lastStreamBytes) bps = (st.outputBytes - S.lastStreamBytes) * 8 / ((now - S.lastStreamTs) / 1000);
    S.lastStreamBytes = st.outputBytes; S.lastStreamTs = now;
    $('#statBitrate').textContent = st.outputActive ? fmtBytes(bps) + (st.outputCongestion > 0.2 ? ' ⚠ rede congestionada' : '') : '–';
    $('#streamInfo').textContent = st.outputActive ? (st.outputTimecode || '').split('.')[0] + (st.outputSkippedFrames ? ` · ${st.outputSkippedFrames} perdidos` : '') : '';
    renderStream();
  }
  function renderStream() {
    const b = $('#streamBadge'); b.textContent = S.streaming ? '● AO VIVO' : 'Fora do ar'; b.classList.toggle('live', S.streaming);
    const btn = $('#btnStream');
    btn.textContent = S.streaming ? '■ Encerrar transmissão' : '▶ Iniciar transmissão';
    btn.className = S.streaming ? 'danger' : 'ok';
    btn.disabled = !S.obs;
  }
  function renderRecord() {
    const btn = $('#btnRecord'); btn.textContent = S.recording ? '⏹ Parar gravação' : '⏺ Gravar'; btn.classList.toggle('danger', S.recording); btn.disabled = !S.obs;
  }
  $('#btnStream').addEventListener('click', async () => {
    try {
      if (S.streaming) { if (!confirm('Encerrar a transmissão agora?')) return; await obs('StopStream'); toast('Transmissão encerrada'); }
      else { await obs('StartStream'); toast('Transmissão iniciada'); }
    } catch (e) { toast(e.message, true); }
  });
  $('#btnRecord').addEventListener('click', async () => {
    try { await obs(S.recording ? 'StopRecord' : 'StartRecord'); } catch (e) { toast(e.message, true); }
  });

  // Tally: avisa cada celular se está no ar (fonte com o nome da câmera na cena de programa)
  async function updateTally() {
    if (!S.obs || !S.program) return;
    let names = [];
    try {
      const items = await obs('GetSceneItemList', { sceneName: S.program });
      names = items.sceneItems.map((i) => i.sourceName);
      // Um nível de cenas aninhadas (ex.: "Multiview" com cenas dentro)
      for (const it of items.sceneItems.filter((i) => i.isGroup || i.sourceType === 'OBS_SOURCE_TYPE_SCENE')) {
        try {
          const sub = it.isGroup ? await obs('GetGroupSceneItemList', { sceneName: it.sourceName }) : await obs('GetSceneItemList', { sceneName: it.sourceName });
          names.push(...sub.sceneItems.map((i) => i.sourceName));
        } catch { /* ignorar */ }
      }
    } catch { return; }
    const joined = names.join('\n').toLowerCase();
    for (const cam of S.cams) {
      const on = joined.includes(cam.name.toLowerCase());
      if (S.tally[cam.name] !== on) { S.tally[cam.name] = on; camControl(cam.name, 'tally', on); }
    }
    renderCams();
  }

  // ------------------------------------------------------------ Overlay / legendas
  function renderOverlayState() {
    const o = S.overlay;
    const set = (id, on, txt) => { const b = $(id); b.textContent = on ? 'NA TELA' : txt; b.className = 'badge ' + (on ? 'on' : ''); };
    set('#ltState', o.lowerThird && o.lowerThird.visible, 'oculta');
    set('#vsState', o.verse && o.verse.visible, 'oculto');
    set('#tkState', o.ticker && o.ticker.visible, 'oculto');
    set('#ttState', o.title && o.title.visible, 'oculto');
    set('#cdState', o.countdown && o.countdown.visible, 'oculta');
    set('#lyState', o.lyrics && o.lyrics.visible, 'oculta');
    set('#ctState', o.cartao && o.cartao.visible, 'oculto');
    set('#qrState', o.qr && o.qr.visible && o.qr.texto, 'oculto');
    set('#lgState', o.logo && o.logo.visible && o.logo.url, 'oculta');
    set('#rlState', o.relogio && o.relogio.visible, 'oculto');
  }
  $('#ltShow').addEventListener('click', () => overlayPatch({ lowerThird: { visible: true, title: $('#ltTitle').value, subtitle: $('#ltSubtitle').value } }));
  $('#ltHide').addEventListener('click', () => overlayPatch({ lowerThird: { visible: false } }));
  $('#vsShow').addEventListener('click', () => overlayPatch({ verse: { visible: true, ref: $('#vsRef').value, text: $('#vsText').value } }));
  $('#vsHide').addEventListener('click', () => overlayPatch({ verse: { visible: false } }));
  $('#tkShow').addEventListener('click', () => overlayPatch({ ticker: { visible: true, text: $('#tkText').value } }));
  $('#tkHide').addEventListener('click', () => overlayPatch({ ticker: { visible: false } }));
  $('#ttShow').addEventListener('click', () => overlayPatch({ title: { visible: true, text: $('#ttText').value } }));
  $('#ttHide').addEventListener('click', () => overlayPatch({ title: { visible: false } }));
  $('#cdShow').addEventListener('click', () => overlayPatch({ countdown: { visible: true, target: countdownTarget(), message: $('#cdMsg').value } }));
  $('#cdHide').addEventListener('click', () => overlayPatch({ countdown: { visible: false } }));
  $('#clearAll').addEventListener('click', clearOverlay);
  function clearOverlay() {
    overlayPatch({ lowerThird: { visible: false }, verse: { visible: false }, ticker: { visible: false }, title: { visible: false }, countdown: { visible: false }, cartao: { visible: false } });
    if (S.config && S.config.holyrics && S.config.holyrics.naLive) hlySet({ naLive: false });
  }
  function countdownTarget() {
    const t = $('#cdTime').value;
    if (t) { const [h, m] = t.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); if (d < new Date()) d.setDate(d.getDate() + 1); return d.getTime(); }
    return Date.now() + Number($('#cdMinutes').value || 0) * 60000;
  }

  // Modelos salvos
  function savePresets() { fetch('/api/presets', { method: 'PUT', body: JSON.stringify(S.presets) }); }
  $('#ltSave').addEventListener('click', () => { const t = $('#ltTitle').value.trim(); if (!t) return; S.presets.legendas.push({ title: t, subtitle: $('#ltSubtitle').value.trim() }); savePresets(); });
  $('#vsSave').addEventListener('click', () => { const r = $('#vsRef').value.trim(); if (!r) return; S.presets.versiculos.push({ ref: r, text: $('#vsText').value.trim() }); savePresets(); });
  $('#tkSave').addEventListener('click', () => { const t = $('#tkText').value.trim(); if (!t) return; S.presets.avisos.push(t); savePresets(); });
  function cartaoAtual() { return { titulo: $('#ctTitulo').value.trim(), texto: $('#ctTexto').value.trim(), imagem: $('#ctImagem').value, cor: $('#ctCor').value }; }
  function mostrarCartao(c) { overlayPatch({ cartao: Object.assign({ visible: true }, c, { imagem: c.imagem ? '/imagens/' + encodeURIComponent(c.imagem) : '' }) }); }
  $('#ctShow').addEventListener('click', () => { const c = cartaoAtual(); if (!c.titulo && !c.texto && !c.imagem) return toast('Escreva um título, um texto ou escolha uma imagem', true); mostrarCartao(c); });
  $('#ctHide').addEventListener('click', () => overlayPatch({ cartao: { visible: false } }));
  $('#ctSave').addEventListener('click', () => { const c = cartaoAtual(); if (!c.titulo && !c.imagem) return toast('Dê um título ao cartão', true); S.presets.cartoes = S.presets.cartoes || []; S.presets.cartoes.push(c); savePresets(); toast('Modelo salvo'); });
  function renderPresets() {
    const mk = (box, list, label, onPick) => {
      box.innerHTML = '';
      list.forEach((p, i) => {
        box.append(el('div', { class: 'chip', onclick: () => onPick(p) }, [
          el('span', { text: label(p) }),
          el('button', { class: 'x', text: '✕', title: 'Remover', onclick: (e) => { e.stopPropagation(); list.splice(i, 1); savePresets(); } }),
        ]));
      });
    };
    mk($('#ltPresets'), S.presets.legendas, (p) => p.title + (p.subtitle ? ' · ' + p.subtitle : ''), (p) => { $('#ltTitle').value = p.title; $('#ltSubtitle').value = p.subtitle || ''; overlayPatch({ lowerThird: { visible: true, title: p.title, subtitle: p.subtitle || '' } }); });
    mk($('#vsPresets'), S.presets.versiculos, (p) => p.ref, (p) => { $('#vsRef').value = p.ref; $('#vsText').value = p.text || ''; overlayPatch({ verse: { visible: true, ref: p.ref, text: p.text || '' } }); });
    mk($('#tkPresets'), S.presets.avisos, (p) => p, (p) => { $('#tkText').value = p; overlayPatch({ ticker: { visible: true, text: p } }); });
    mk($('#ctPresets'), S.presets.cartoes || [], (p) => p.titulo || p.imagem, (p) => { $('#ctTitulo').value = p.titulo || ''; $('#ctTexto').value = p.texto || ''; $('#ctImagem').value = p.imagem || ''; if (p.cor) $('#ctCor').value = p.cor; mostrarCartao(p); });
    renderRiFields();
  }

  // ------------------------------------------------------------ Roteiro
  function saveRoteiro() { fetch('/api/roteiro', { method: 'PUT', body: JSON.stringify(S.roteiro) }); }
  function renderRoteiro() {
    const ol = $('#roteiroList'); ol.innerHTML = ''; ol.classList.toggle('editing', S.editing);
    const { itens, atual } = S.roteiro;
    itens.forEach((it, i) => {
      const desc = [it.cena ? '🎬 ' + it.cena : null, it.transicao ? '🎞️ ' + it.transicao + (it.transicaoDur ? ' ' + it.transicaoDur + ' ms' : '') : null, acaoLabel(it.acao)].filter(Boolean).join('  ·  ');
      const li = el('li', { class: i === atual ? 'atual' : i < atual ? 'feito' : '', onclick: () => goTo(i) }, [
        el('span', { class: 'num', text: String(i + 1) }),
        el('div', { class: 'info' }, [el('div', { class: 't', text: it.titulo }), el('div', { class: 'd', text: desc || 'sem ação' })]),
        el('div', { class: 'tools' }, [
          el('button', { text: '▲', onclick: (e) => { e.stopPropagation(); move(i, -1); } }),
          el('button', { text: '▼', onclick: (e) => { e.stopPropagation(); move(i, 1); } }),
          el('button', { text: '✕', onclick: (e) => { e.stopPropagation(); itens.splice(i, 1); if (S.roteiro.atual >= itens.length) S.roteiro.atual = itens.length - 1; saveRoteiro(); } }),
        ]),
      ]);
      ol.append(li);
    });
    if (!itens.length) ol.append(el('p', { class: 'muted', text: 'Roteiro vazio. Clique em Editar para montar a ordem do culto.' }));
    $('#btnNext').textContent = atual + 1 < itens.length ? `Próximo ▶  ${itens[atual + 1].titulo}` : 'Fim do roteiro';
    $('#btnNext').disabled = atual + 1 >= itens.length;
    $('#btnPrev').disabled = atual <= 0;
  }
  function acaoLabel(a) {
    if (!a || a.tipo === 'none') return null;
    const map = { video: '🎬 vídeo: ' + (a.videoNome || ''), videoStop: '🎬 vídeo: parar', cartao: '🖼️ cartão: ' + (a.cartao || ''), cartaoOff: '🖼️ cartão: ocultar', qr: '▦ QR de oferta', qrOff: '▦ QR: ocultar', clear: '🧹 limpar legendas', lower: '🔤 ' + (a.title || ''), verse: '📖 ' + (a.ref || ''), title: '🏷️ ' + (a.text || ''), ticker: '📣 aviso', countdown: '⏱ contagem ' + (a.minutes || 0) + ' min', letra: '🎵 letra do Holyrics', letraOff: '🎵 letra: ocultar' };
    return map[a.tipo] || a.tipo;
  }
  function move(i, d) { const it = S.roteiro.itens; const j = i + d; if (j < 0 || j >= it.length) return; [it[i], it[j]] = [it[j], it[i]]; if (S.roteiro.atual === i) S.roteiro.atual = j; else if (S.roteiro.atual === j) S.roteiro.atual = i; saveRoteiro(); }
  function nextItem(d) { const n = S.roteiro.atual + d; if (n < 0 || n >= S.roteiro.itens.length) return; goTo(n); }
  async function goTo(i) {
    const it = S.roteiro.itens[i]; if (!it) return;
    S.roteiro.atual = i; saveRoteiro(); renderRoteiro();
    if (it.cena) setScene(it.cena, it.transicao || '', it.transicaoDur || 0);
    runAcao(it.acao);
  }
  function runAcao(a) {
    if (!a || a.tipo === 'none') return;
    if (a.tipo === 'clear') return clearOverlay();
    if (a.tipo === 'lower') return overlayPatch({ lowerThird: { visible: true, title: a.title || '', subtitle: a.subtitle || '' } });
    if (a.tipo === 'verse') return overlayPatch({ verse: { visible: true, ref: a.ref || '', text: a.text || '' } });
    if (a.tipo === 'title') return overlayPatch({ title: { visible: true, text: a.text || '' } });
    if (a.tipo === 'ticker') return overlayPatch({ ticker: { visible: true, text: a.text || '' } });
    if (a.tipo === 'countdown') return overlayPatch({ countdown: { visible: true, target: Date.now() + Number(a.minutes || 0) * 60000, message: a.message || '' } });
    if (a.tipo === 'letra') return hlySet({ naLive: true });
    if (a.tipo === 'letraOff') return hlySet({ naLive: false });
    if (a.tipo === 'cartao') { const p = (S.presets.cartoes || []).find((c) => (c.titulo || c.imagem) === a.cartao); if (p) mostrarCartao(p); else toast('Modelo de cartão não encontrado: ' + a.cartao, true); return; }
    if (a.tipo === 'cartaoOff') return overlayPatch({ cartao: { visible: false } });
    if (a.tipo === 'qr') return grSet({ qr: { visible: true } });
    if (a.tipo === 'qrOff') return grSet({ qr: { visible: false } });
    if (a.tipo === 'video') return plPost('tocar', { id: a.video });
    if (a.tipo === 'videoStop') return plPost('parar');
  }
  $('#btnNext').addEventListener('click', () => nextItem(1));
  $('#btnPrev').addEventListener('click', () => nextItem(-1));
  $('#btnEditRoteiro').addEventListener('click', () => { S.editing = !S.editing; $('#roteiroEdit').style.display = S.editing ? '' : 'none'; $('#btnEditRoteiro').textContent = S.editing ? '✔ Concluir' : '✏️ Editar'; renderRoteiro(); });
  $('#riAcao').addEventListener('change', renderRiFields);
  function renderRiFields() {
    const t = $('#riAcao').value, box = $('#riFields'); box.innerHTML = '';
    const f = (id, label, ta) => box.append(el('div', { class: 'field' }, [el('label', { text: label }), el(ta ? 'textarea' : 'input', { id })]));
    if (t === 'lower') { f('riTitle', 'Nome'); f('riSubtitle', 'Função'); }
    if (t === 'verse') { f('riRef', 'Referência'); f('riText', 'Texto', true); }
    if (t === 'title' || t === 'ticker') f('riText', 'Texto');
    if (t === 'countdown') { f('riMinutes', 'Minutos'); f('riMessage', 'Mensagem'); }
    if (t === 'video') {
      const sel = el('select', { id: 'riVideo' });
      for (const v of ((S.player && S.player.itens) || [])) sel.append(el('option', { value: v.id, text: v.nome }));
      box.append(el('div', { class: 'field' }, [el('label', { text: sel.options.length ? 'Vídeo da lista (aba Vídeos)' : 'Adicione vídeos na aba Vídeos primeiro' }), sel]));
    }
    if (t === 'cartao') {
      const sel = el('select', { id: 'riCartao' });
      for (const c of (S.presets.cartoes || [])) sel.append(el('option', { value: c.titulo || c.imagem, text: c.titulo || c.imagem }));
      box.append(el('div', { class: 'field' }, [el('label', { text: (S.presets.cartoes || []).length ? 'Modelo de cartão (salvo na aba Gráficos)' : 'Salve um modelo de cartão na aba Gráficos primeiro' }), sel]));
    }
  }
  $('#riAdd').addEventListener('click', () => {
    const titulo = $('#riTitulo').value.trim(); if (!titulo) return toast('Dê um título ao item', true);
    const tipo = $('#riAcao').value;
    const v = (id) => ($('#' + id) ? $('#' + id).value : '');
    const acao = { tipo, title: v('riTitle'), subtitle: v('riSubtitle'), ref: v('riRef'), text: v('riText'), minutes: Number(v('riMinutes') || 0), message: v('riMessage'), cartao: v('riCartao') };
    if (tipo === 'video') { acao.video = Number(v('riVideo')); const it = ((S.player && S.player.itens) || []).find((x) => x.id === acao.video); acao.videoNome = it ? it.nome : ''; if (!it) return toast('Escolha um vídeo da lista', true); }
    const item = { titulo, cena: $('#riCena').value, acao };
    if ($('#riTrans').value) { item.transicao = $('#riTrans').value; if (Number($('#riTransDur').value)) item.transicaoDur = Number($('#riTransDur').value); }
    S.roteiro.itens.push(item);
    $('#riTitulo').value = ''; saveRoteiro();
  });
  $('#riClear').addEventListener('click', () => { if (confirm('Apagar todo o roteiro?')) { S.roteiro = { itens: [], atual: -1 }; saveRoteiro(); } });
  function renderRoteiroSceneOptions() {
    const sel = $('#riCena'); const cur = sel.value; sel.innerHTML = '<option value="">(não trocar)</option>';
    for (const s of S.scenes) sel.append(el('option', { value: s, text: s }));
    sel.value = cur;
  }

  // ------------------------------------------------------------ Câmeras
  function renderCams() {
    const box = $('#camList'); box.innerHTML = '';
    if (!S.cams.length) { box.append(el('p', { class: 'muted', text: 'Nenhum celular conectado. Abra o endereço abaixo no celular.' })); return; }
    for (const c of S.cams) {
      const m = c.meta || {}, cap = m.capabilities || {};
      const live = !!S.tally[c.name];
      const metaBits = [
        m.width ? `${m.width}×${m.height} ${m.fps || 0}fps` : (m.capWidth ? `${m.capWidth}×${m.capHeight}` : 'aguardando vídeo'),
        m.bitrate ? fmtBytes(m.bitrate) : null, m.codec || null,
        m.battery != null ? (m.charging ? '⚡' : '🔋') + m.battery + '%' : null,
        `OBS: ${c.viewers}`,
      ].filter(Boolean);
      const card = el('div', { class: 'cam' + (live ? ' tally' : '') }, [
        el('div', { class: 'head' }, [el('span', { class: 'dot ok' }), el('span', { class: 'n', text: c.name }), live ? el('span', { class: 'badge live', text: 'NO AR' }) : null]),
        el('div', { class: 'meta' }, metaBits.map((t) => el('span', { text: t }))),
        el('div', { class: 'ctl' }, [
          cap.zoom ? el('div', { class: 'sl' }, ['Zoom', el('input', { type: 'range', min: 1, max: 8, step: 0.1, value: m.zoom || 1, oninput: (e) => camControl(c.name, 'zoom', Number(e.target.value)) })]) : null,
          cap.exposure ? el('div', { class: 'sl' }, ['Exposição', el('input', { type: 'range', min: -3, max: 3, step: 1, value: 0, oninput: (e) => camControl(c.name, 'exposure', Number(e.target.value)) })]) : null,
          el('select', { onchange: (e) => camControl(c.name, 'quality', Number(e.target.value)) }, [540, 720, 1080].map((q) => el('option', { value: q, text: q + 'p', selected: m.quality === q }))),
          cap.torch ? el('button', { class: m.torch ? 'active' : '', text: '🔦 Lanterna', onclick: () => camControl(c.name, 'torch', !m.torch) }) : el('button', { text: '🔄 Trocar câmera', onclick: () => camControl(c.name, 'flip') }),
          m.hasAudio ? el('button', { class: m.muted ? 'active' : '', text: m.muted ? '🔇 Mudo' : '🎤 Áudio', onclick: () => camControl(c.name, 'mute', !m.muted) }) : null,
          el('button', { text: '↻ Reiniciar vídeo', onclick: () => camControl(c.name, 'restart') }),
        ]),
      ]);
      box.append(card);
    }
  }

  function renderQr() {
    if (!S.info) return;
    const box = $('#qrArea'); box.innerHTML = '';
    for (const { ip, iface } of S.info.ips) {
      const url = `https://${ip}:${S.info.httpsPort}/cam`;
      const img = el('img', { src: '/qr.svg?text=' + encodeURIComponent(url), width: 160, height: 160, alt: 'QR' });
      box.append(el('div', { class: 'qr' }, [img, el('div', { html: `<b>${iface}</b><br>${url}` })]));
    }
    const urls = $('#sourceUrls'); urls.innerHTML = '';
    const base = `http://localhost:${S.info.httpPort}`;
    urls.append(el('div', { text: `Overlay: ${base}/overlay` }));
    for (const n of S.info.cameraNames) urls.append(el('div', { text: `${n}: ${base}/view/${encodeURIComponent(n)}` }));
  }
  function renderNet() {
    if (!S.info) return;
    $('#netInfo').innerHTML = S.info.ips.map((x) => `${x.iface}: <b>${x.ip}</b>`).join('<br>') + `<br>HTTP ${S.info.httpPort} (OBS/mesa) · HTTPS ${S.info.httpsPort} (celulares)`;
  }

  // Cria no OBS as cenas e fontes necessárias
  $('#btnSetupObs').addEventListener('click', async () => {
    if (!S.obs) return toast('Conecte o OBS primeiro (aba Config).', true);
    const log = $('#setupLog'); log.textContent = ''; log.classList.add('show');
    const say = (t) => { log.textContent += t + '\n'; log.scrollTop = 1e9; };
    const base = `http://localhost:${S.info.httpPort}`;
    const W = S.info.viewWidth || 1920, H = S.info.viewHeight || 1080;
    try {
      const sl = await obs('GetSceneList'); const scenes = new Set(sl.scenes.map((s) => s.sceneName));
      const inputs = new Set((await obs('GetInputList')).inputs.map((i) => i.inputName));
      // Overlay
      if (!scenes.has('Overlay')) { await obs('CreateScene', { sceneName: 'Overlay' }); say('✔ cena "Overlay" criada'); scenes.add('Overlay'); }
      if (!inputs.has('Overlay (legendas)')) {
        await obs('CreateInput', { sceneName: 'Overlay', inputName: 'Overlay (legendas)', inputKind: 'browser_source', inputSettings: { url: `${base}/overlay`, width: W, height: H, shutdown: false, restart_when_active: false, css: '' } });
        say('✔ fonte "Overlay (legendas)" criada');
      }
      // Uma cena por celular
      for (const n of S.info.cameraNames) {
        const scene = `Cam – ${n}`, input = `${n} (celular)`;
        if (!scenes.has(scene)) { await obs('CreateScene', { sceneName: scene }); scenes.add(scene); say(`✔ cena "${scene}" criada`); }
        if (!inputs.has(input)) {
          await obs('CreateInput', { sceneName: scene, inputName: input, inputKind: 'browser_source', inputSettings: { url: `${base}/view/${encodeURIComponent(n)}`, width: W, height: H, shutdown: false, restart_when_active: false, reroute_audio: true } });
          say(`✔ fonte "${input}" criada`);
        }
      }
      // Overlay em todas as cenas
      for (const scene of scenes) {
        if (scene === 'Overlay') continue;
        const items = await obs('GetSceneItemList', { sceneName: scene });
        if (items.sceneItems.some((i) => i.sourceName === 'Overlay')) continue;
        await obs('CreateSceneItem', { sceneName: scene, sourceName: 'Overlay' });
        say(`✔ overlay adicionado em "${scene}"`);
      }
      say('Pronto! Dica: nas fontes de navegador, deixe "Desligar fonte quando não visível" desmarcado para a câmera não reconectar a cada troca.');
      refreshObs();
    } catch (e) { say('✖ ' + e.message); }
  });

  // ------------------------------------------------------------ Áudio
  async function refreshAudio() {
    if (!S.obs) return;
    try {
      const list = (await obs('GetInputList')).inputs;
      const res = await obsBatch(list.map((i) => ({ request: 'GetInputVolume', data: { inputName: i.inputName } })));
      const mutes = await obsBatch(list.map((i) => ({ request: 'GetInputMute', data: { inputName: i.inputName } })));
      S.audioInputs = list.map((i, k) => res[k].ok ? { name: i.inputName, db: res[k].data.inputVolumeDb, muted: mutes[k].ok ? mutes[k].data.inputMuted : false } : null).filter(Boolean);
      renderAudio();
    } catch { /* ignorar */ }
  }
  function renderAudio() {
    const box = $('#audioList'); box.innerHTML = '';
    if (!S.audioInputs.length) box.append(el('p', { class: 'muted', text: 'Nenhuma fonte de áudio encontrada no OBS.' }));
    for (const i of S.audioInputs) {
      box.append(el('div', { class: 'in' }, [
        el('div', { class: 'name', text: i.name }),
        el('button', { class: i.muted ? 'muted' : '', text: i.muted ? '🔇' : '🔊', title: 'Mudo', onclick: () => obs('SetInputMute', { inputName: i.name, inputMuted: !i.muted }).catch(() => {}) }),
        el('input', { type: 'range', min: -60, max: 0, step: 0.5, value: Math.max(-60, i.db), oninput: (e) => { const db = Number(e.target.value); obs('SetInputVolume', { inputName: i.name, inputVolumeDb: db <= -60 ? -100 : db }).catch(() => {}); } }),
        el('div', { class: 'db', text: i.db <= -60 ? '-∞' : i.db.toFixed(1) + ' dB' }),
      ]));
    }
  }
  $('#btnAudioRefresh').addEventListener('click', refreshAudio);

  // ------------------------------------------------------------ Config
  function renderConfig() {
    const c = S.config; if (!c) return;
    $('#cfgHost').value = c.obs.host; $('#cfgPort').value = c.obs.port;
    $('#cfgObsInvisivel').checked = c.obs.invisivel !== false; $('#cfgObsAuto').checked = c.obs.autoAbrir !== false;
    $('#cfgPwdHint').textContent = c.obs.hasPassword ? '(já salva)' : '(nenhuma)';
    $('#cfgCams').value = (c.cameraNames || []).join('\n');
  }
  // ---- Replay instantâneo
  let rpEditing = false;
  async function rpPost(acao, body) {
    const r = await (await fetch('/api/replay/' + acao, { method: 'POST', body: JSON.stringify(body || {}) })).json();
    if (!r.ok) throw new Error(r.erro || 'falhou');
    return r;
  }
  async function rpSalvar() {
    if (!S.obs) return toast('OBS não conectado', true);
    try { const r = await rpPost('salvar'); toast('Replay salvo: ' + r.salvo.nome); }
    catch (e) { toast('Não salvou o replay: ' + e.message, true); }
  }
  async function rpExibir(arquivo) {
    try { await rpPost('exibir', { arquivo, velocidade: Number($('#rpVel').value) }); }
    catch (e) { toast('Não exibiu o replay: ' + e.message, true); }
  }
  function renderReplayConfig() {
    const r = S.config && S.config.replay; if (!r) return;
    $('#rpAuto').checked = !!r.auto; $('#rpSeg').textContent = r.segundos;
    if (!rpEditing) { $('#rpVel').value = String(r.velocidade || 100); $('#rpDur').value = String(r.segundos || 30); }
  }
  function renderReplay() {
    const st = S.replay || {}; const sb = $('#rpStatus');
    sb.className = 'badge ' + (st.exibindo ? 'live' : st.bufferAtivo ? 'ok' : st.erro ? 'danger' : '');
    sb.textContent = st.exibindo ? 'REPLAY NO AR' : st.bufferAtivo ? 'buffer ligado' : 'buffer desligado';
    $('#rpVoltar').hidden = !st.exibindo;
    $('#rpExibir').disabled = !(st.salvos && st.salvos.length);
    const erroBox = $('#rpErro'); const naoAtivado = /não está ativado/.test(st.erro || '');
    erroBox.hidden = !!st.bufferAtivo;
    $('#rpErroMsg').textContent = st.erro || (S.obs ? 'O buffer de replay está desligado.' : 'Conecte o OBS para usar o replay.');
    $('#rpAtivarObs').hidden = !naoAtivado;
    $('#rpLigar').hidden = naoAtivado || !S.obs;
    const box = $('#rpLista');
    if (!st.salvos || !st.salvos.length) { box.innerHTML = '<p class="muted">Nenhum replay salvo ainda. Aperte <b>R</b> logo depois do momento que quer rever.</p>'; return; }
    box.innerHTML = '';
    st.salvos.forEach((s, i) => box.append(el('div', { class: 'rp-item' + (st.exibindo && st.arquivoExibido === s.arquivo ? ' onair' : '') }, [
      el('span', { class: 'hora', text: s.hora }), el('span', { class: 'nome', text: (i === 0 ? 'último · ' : '') + s.nome, title: s.arquivo }),
      el('button', { class: 'small primary', text: '▶ Exibir', onclick: () => rpExibir(s.arquivo) }),
    ])));
  }
  $('#rpSalvar').addEventListener('click', rpSalvar);
  $('#rpExibir').addEventListener('click', () => rpExibir());
  $('#rpVoltar').addEventListener('click', () => rpPost('voltar').catch((e) => toast(e.message, true)));
  $('#rpLigar').addEventListener('click', async () => { try { await rpPost('ligar'); toast('Buffer de replay ligado'); } catch (e) { toast(e.message, true); } });
  $('#rpAtivarObs').addEventListener('click', async () => {
    if (!confirm('O OBS precisa estar FECHADO para isso. Fechou o OBS?')) return;
    try { const r = await rpPost('ativar-obs'); toast(r.launched ? 'Replay ativado; abrindo o OBS…' : 'Replay ativado no perfil do OBS. Abra o OBS.'); }
    catch (e) { toast(e.message, true); }
  });
  for (const id of ['#rpVel', '#rpDur']) { $(id).addEventListener('focus', () => { rpEditing = true; }); $(id).addEventListener('blur', () => { rpEditing = false; }); }
  $('#rpVel').addEventListener('change', () => fetch('/api/replay', { method: 'PUT', body: JSON.stringify({ velocidade: Number($('#rpVel').value) }) }));
  $('#rpDur').addEventListener('change', () => { fetch('/api/replay', { method: 'PUT', body: JSON.stringify({ segundos: Number($('#rpDur').value) }) }); toast('A duração vale quando o replay for ativado no OBS (ou mude em Configurações → Saída do OBS).'); });
  $('#rpAuto').addEventListener('change', () => fetch('/api/replay', { method: 'PUT', body: JSON.stringify({ auto: $('#rpAuto').checked }) }));

  // ---- Holyrics (letra do telão na live)
  const HLY_ESTADO = { desligado: ['', 'desligado'], conectando: ['warn', 'conectando…'], conectado: ['ok', 'conectado'], erro: ['danger', 'erro'] };
  let hlyEditing = false; // enquanto o operador digita, não sobrescreve os campos
  async function hlySet(patch) {
    try {
      const r = await (await fetch('/api/holyrics', { method: 'PUT', body: JSON.stringify(patch) })).json();
      if (r.config) { S.config = r.config; renderHolyConfig(); }
      if (r.state) { S.holyrics = r.state; renderHoly(); }
      return r;
    } catch (e) { toast('Não consegui salvar: ' + e.message, true); }
  }
  function renderHolyConfig() {
    const h = S.config && S.config.holyrics; if (!h) return;
    if (!hlyEditing) { $('#hlyHost').value = h.host || ''; $('#hlyPort').value = h.port || 8091; }
    $('#hlyTokenHint').textContent = h.hasToken ? '(já salvo)' : '(nenhum)';
    $('#hlyAtivo').checked = !!h.ativo;
    $('#hlyNaLive').checked = !!h.naLive;
    const e = h.estilo || {};
    $('#hlyPosicao').value = e.posicao || 'inferior'; $('#hlyTamanho').value = e.tamanho || 'M'; $('#hlyFundo').value = e.fundo || 'faixa';
    $('#hlyMaiusculas').checked = !!e.maiusculas; $('#hlyTitulo').checked = !!e.titulo;
    renderHolyPreview();
    renderHoly();
  }
  function renderHolyPreview() {
    const p = $('#hlyPreview');
    p.className = ['hly-preview', $('#hlyPosicao').value, $('#hlyTamanho').value, $('#hlyFundo').value, $('#hlyMaiusculas').checked ? 'maiusculas' : ''].filter(Boolean).join(' ');
    $('.t', p).textContent = $('#hlyTitulo').checked ? 'Grande é o Senhor' : '';
  }
  function renderHoly() {
    const st = S.holyrics || { estado: 'desligado' }, h = (S.config && S.config.holyrics) || {};
    const [cls, label] = HLY_ESTADO[st.estado] || ['', st.estado];
    const sb = $('#hlyStatus'); sb.className = 'badge ' + cls; sb.textContent = label + (st.estado === 'erro' && st.erro ? ' · ' + st.erro : '');
    const badge = $('#hlyBadge'); badge.hidden = !h.ativo;
    if (h.ativo) setBadge(badge, st.estado === 'conectado' ? 'ok' : st.estado === 'erro' ? 'danger' : 'warn', 'Holyrics');
    const box = $('#hlyAgora');
    if (!h.ativo) box.innerHTML = '<span class="muted">Ligue a conexão com o Holyrics abaixo.</span>';
    else if (st.estado !== 'conectado') box.innerHTML = '<span class="muted">' + (st.estado === 'erro' ? 'Sem conexão: ' + (st.erro || '') : 'Conectando ao Holyrics…') + '</span>';
    else if (!st.atual) box.innerHTML = '<span class="muted">Nada em exibição no Holyrics.</span>';
    else {
      const tipo = { song: 'Música', text: 'Texto', verse: 'Versículo', image: 'Imagem', video: 'Vídeo', audio: 'Áudio', announcement: 'Anúncio', quick_presentation: 'Apresentação', automatic_presentation: 'Apresentação' }[st.atual.type] || st.atual.type;
      box.innerHTML = '';
      const nome = el('b', { text: st.atual.name || '' });
      box.append(el('div', { class: 'h' }, [el('span', {}, [tipo + ': ', nome]), el('span', { text: st.atual.total ? 'slide ' + st.atual.slide + '/' + st.atual.total : '' })]));
      const vazio = st.atual.type === 'verse' ? 'O Holyrics não envia o texto do versículo pela API; use o versículo da aba Legendas.' : 'Tela sem texto';
      box.append(el('div', { class: 'txt' + (st.texto ? '' : ' muted'), text: st.texto || vazio }));
    }
  }
  for (const id of ['#hlyHost', '#hlyPort', '#hlyToken']) { $(id).addEventListener('focus', () => { hlyEditing = true; }); $(id).addEventListener('blur', () => { hlyEditing = false; }); }
  $('#hlySalvar').addEventListener('click', async () => {
    const r = await hlySet({ host: $('#hlyHost').value, port: Number($('#hlyPort').value) || 8091, token: $('#hlyToken').value, ativo: $('#hlyAtivo').checked });
    if (r) { $('#hlyToken').value = ''; toast('Holyrics salvo'); }
  });
  $('#hlyAtivo').addEventListener('change', () => hlySet({ ativo: $('#hlyAtivo').checked }));
  $('#hlyTestar').addEventListener('click', async () => {
    const msg = $('#hlyMsg'); msg.textContent = 'Testando…';
    try {
      const r = await (await fetch('/api/holyrics/testar', { method: 'POST', body: JSON.stringify({ host: $('#hlyHost').value, port: Number($('#hlyPort').value) || 8091, token: $('#hlyToken').value }) })).json();
      msg.textContent = r.ok ? ('Conectou ✔' + (r.apresentando ? ' · exibindo: ' + (r.nome || 'item') : ' · nada em exibição agora')) : ('Falhou: ' + r.erro);
    } catch (e) { msg.textContent = 'Falhou: ' + e.message; }
  });
  $('#hlyNaLive').addEventListener('change', () => hlySet({ naLive: $('#hlyNaLive').checked }));
  for (const id of ['#hlyPosicao', '#hlyTamanho', '#hlyFundo', '#hlyMaiusculas', '#hlyTitulo']) $(id).addEventListener('change', () => {
    renderHolyPreview();
    hlySet({ estilo: { posicao: $('#hlyPosicao').value, tamanho: $('#hlyTamanho').value, fundo: $('#hlyFundo').value, maiusculas: $('#hlyMaiusculas').checked, titulo: $('#hlyTitulo').checked } });
  });

  // ---- Multidestino (YouTube + Instagram)
  const EST_LABEL = { parado: 'parado', conectando: 'conectando…', 'no ar': 'NO AR', reiniciando: 'reconectando…', erro: 'erro' };
  let destDirty = false;
  function destEl(id) { return $('#destList').querySelector(`.dest[data-id="${CSS.escape(id)}"]`); }

  function renderDests() {
    if (!S.config || destDirty) return;
    const list = $('#destList'); list.innerHTML = '';
    for (const d of S.config.relay.destinos) {
      const card = el('div', { class: 'dest' + (d.modo === 'vertical' ? ' vertical' : ''), 'data-id': d.id });
      card.innerHTML = `
        <div class="head">
          <label class="switch"><input type="checkbox" class="ativo" ${d.ativo ? 'checked' : ''}> ligado</label>
          <input type="text" class="nome" value="">
          <span class="st parado">parado</span>
          <span class="muted kb"></span>
        </div>
        <div class="body">
          <div class="full"><label>Servidor (URL RTMP)</label><input type="text" class="url" placeholder="rtmp://..."></div>
          <div class="full"><label>Chave da transmissão <span class="muted hint"></span></label><input type="password" class="key" placeholder="${d.hasKey ? 'deixe em branco para manter' : 'cole a chave aqui'}"></div>
          <div><label>Formato</label><select class="modo"><option value="copy">Mesmo vídeo do OBS (16:9, sem recodificar)</option><option value="vertical">Recorte vertical 9:16 (Instagram)</option></select></div>
          <div class="vert"><label>Resolução</label><select class="res"><option value="720">720×1280</option><option value="1080">1080×1920</option></select></div>
          <div class="vert"><label>Bitrate (kbps)</label><input type="number" class="bitrate" min="800" max="8000" step="100"></div>
          <div class="vert full"><label>Posição do recorte (esquerda ↔ direita)</label><div class="sl"><span>◀</span><input type="range" class="cropX" min="0" max="1" step="0.01"><span>▶</span></div></div>
          <div class="err" hidden></div>
          <div class="tools"><button class="restart">Reiniciar envio</button><button class="logbtn ghost">Ver log</button><button class="remove ghost">Remover</button><pre class="log-box log"></pre></div>
        </div>`;
      card.querySelector('.nome').value = d.nome || d.id;
      card.querySelector('.url').value = d.url || '';
      card.querySelector('.hint').textContent = d.hasKey ? '(salva ' + d.keyHint + ')' : '';
      card.querySelector('.modo').value = d.modo || 'copy';
      card.querySelector('.res').value = String(d.res || 720);
      card.querySelector('.bitrate').value = d.bitrate || 2500;
      card.querySelector('.cropX').value = d.cropX ?? 0.5;
      card.querySelector('.modo').addEventListener('change', (e) => card.classList.toggle('vertical', e.target.value === 'vertical'));
      card.querySelector('.restart').addEventListener('click', () => fetch('/api/relay/restart/' + encodeURIComponent(d.id), { method: 'POST' }).then(() => toast('Reiniciando ' + (d.nome || d.id))));
      card.querySelector('.logbtn').addEventListener('click', async () => {
        const box = card.querySelector('.log-box'); box.classList.toggle('show');
        if (box.classList.contains('show')) { const r = await (await fetch('/api/relay/log/' + encodeURIComponent(d.id))).json(); box.textContent = r.lines.join('\n') || '(sem mensagens)'; }
      });
      card.querySelector('.remove').addEventListener('click', () => { if (confirm('Remover o destino ' + (d.nome || d.id) + '?')) { card.remove(); destDirty = true; } });
      for (const inp of card.querySelectorAll('input, select')) inp.addEventListener('input', () => { destDirty = true; });
      list.appendChild(card);
    }
    renderRelay();
  }

  function readDests() {
    const out = [];
    for (const card of $$('#destList .dest')) {
      const key = card.querySelector('.key').value;
      out.push({
        id: card.dataset.id, nome: card.querySelector('.nome').value, ativo: card.querySelector('.ativo').checked,
        url: card.querySelector('.url').value, key, modo: card.querySelector('.modo').value,
        res: Number(card.querySelector('.res').value), bitrate: Number(card.querySelector('.bitrate').value), cropX: Number(card.querySelector('.cropX').value),
      });
    }
    return out;
  }

  function renderRelay() {
    const st = S.relay; if (!st) return;
    const enc = $('#relayEncoder');
    if (enc.options.length <= 1) for (const e of st.encoders) enc.appendChild(el('option', { value: e }, e));
    if (S.config && !destDirty) enc.value = S.config.relay.encoder || 'auto';
    $('#relayHint').textContent = st.ffmpegOk
      ? (st.live ? 'O OBS está enviando para este programa. ' : 'Aguardando o OBS iniciar a transmissão. ') + 'Codificador do recorte vertical em uso: ' + st.encoder + '.'
      : 'ffmpeg não encontrado: o reenvio não vai funcionar. Reinstale o programa.';
    const badges = [];
    for (const [id, s] of Object.entries(st.destinos)) {
      const d = (S.config ? S.config.relay.destinos : []).find((x) => x.id === id) || { nome: id };
      const card = destEl(id);
      if (card) {
        const stEl = card.querySelector('.st'); stEl.textContent = EST_LABEL[s.estado] || s.estado; stEl.className = 'st ' + (s.estado === 'no ar' ? 'noar' : s.estado);
        card.querySelector('.kb').textContent = s.estado === 'no ar' ? `${s.kbps} kbps · ${s.fps ? s.fps + ' fps · ' : ''}${s.tempo}` : (s.tentativas ? `tentativa ${s.tentativas}` : '');
        const err = card.querySelector('.err'); err.hidden = !s.erro; err.textContent = s.erro || '';
      }
      if (d.ativo) badges.push(`<span class="badge ${s.estado === 'no ar' ? 'ok' : s.estado === 'erro' ? 'err' : 'warn'}">${(d.nome || id).slice(0, 10)} ${s.estado === 'no ar' ? '●' : '○'}</span>`);
    }
    $('#destBadges').innerHTML = badges.join('');
  }

  $('#destSave').addEventListener('click', async () => {
    const body = { destinos: readDests(), encoder: $('#relayEncoder').value };
    destDirty = false;
    const r = await (await fetch('/api/relay/destinos', { method: 'PUT', body: JSON.stringify(body) })).json();
    if (r.error) { toast('Erro: ' + r.error, true); return; }
    S.config = r; renderDests(); toast('Destinos salvos');
  });
  $('#destAdd').addEventListener('click', () => {
    if (!S.config) return;
    const id = 'dest' + Date.now().toString(36);
    S.config.relay.destinos.push({ id, nome: 'Novo destino', ativo: false, url: '', modo: 'copy', res: 720, bitrate: 2500, cropX: 0.5 });
    destDirty = false; renderDests(); destDirty = true;
  });

  async function refreshRelayObs() {
    if (!S.obs) { $('#relayObsMsg').textContent = 'OBS desconectado.'; $('#relayPointObs').hidden = true; return; }
    try {
      const s = await obs('GetStreamServiceSettings');
      const want = S.relay ? S.relay.rtmpUrl : 'rtmp://127.0.0.1:1935/live';
      const cur = (s.streamServiceSettings || {}).server || '';
      const ok = s.streamServiceType === 'rtmp_custom' && cur.replace(/\/+$/, '') === want;
      $('#relayObsMsg').innerHTML = ok ? 'O OBS está configurado para transmitir <b>para este programa</b> ✔' : 'O OBS está transmitindo para: <b>' + (cur || s.streamServiceType || 'nada configurado') + '</b>. Para usar o multidestino, aponte-o para este programa.';
      $('#relayPointObs').hidden = ok;
    } catch (e) { $('#relayObsMsg').textContent = 'Não consegui ler a configuração do OBS: ' + e.message; }
  }
  $('#relayPointObs').addEventListener('click', async () => {
    try {
      await obs('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: S.relay.rtmpUrl, key: S.relay.streamKey, use_auth: false } });
      toast('OBS apontado para este programa'); refreshRelayObs();
    } catch (e) { toast('Erro: ' + e.message, true); }
  });

  // ---- OBS instalado neste computador
  async function refreshObsLocal() {
    let st;
    try { st = await (await fetch('/api/obs/local')).json(); } catch { return; }
    const msg = $('#obsLocalMsg'), launch = $('#obsLaunch'), enable = $('#obsEnableWs');
    launch.hidden = true; enable.hidden = true;
    if (!st.installed) { msg.innerHTML = 'OBS Studio <b>não encontrado</b> neste computador. Instale em obsproject.com e reinicie este programa.'; return; }
    $('#obsClose').hidden = !st.running;
    if (st.connected) { msg.innerHTML = 'OBS aberto e <b>conectado</b>' + (st.usingDetectedPassword ? ' (senha lida do próprio OBS).' : '.'); return; }
    if (!st.running) { msg.textContent = 'OBS instalado, mas fechado.'; launch.hidden = false; return; }
    if (!st.websocket || !st.websocket.enabled) { msg.textContent = 'OBS aberto, mas o servidor WebSocket está desligado.'; enable.hidden = false; return; }
    msg.textContent = 'OBS aberto, tentando conectar… Se demorar, confira a senha em "Configurar manualmente".';
  }
  $('#obsLaunch').addEventListener('click', async () => {
    $('#obsLocalMsg').textContent = 'Abrindo o OBS…';
    try {
      const r = await (await fetch('/api/obs/launch', { method: 'POST' })).json();
      if (r.error) throw new Error(r.error);
      toast('OBS iniciado. Conectando em alguns segundos…');
    } catch (e) { toast('Erro: ' + e.message, true); }
    setTimeout(refreshObsLocal, 3000);
  });
  $('#obsEnableWs').addEventListener('click', async () => {
    try {
      const r = await (await fetch('/api/obs/enable-websocket', { method: 'POST' })).json();
      if (r.needsRestart) toast('WebSocket habilitado. Feche e abra o OBS para valer.');
      else toast('WebSocket habilitado.');
    } catch (e) { toast('Erro: ' + e.message, true); }
    setTimeout(refreshObsLocal, 1500);
  });
  refreshObsLocal();
  setInterval(() => { if (!S.obs) refreshObsLocal(); }, 10000);

  $('#cfgSaveObs').addEventListener('click', async () => {
    const body = { obs: { host: $('#cfgHost').value.trim(), port: Number($('#cfgPort').value) } };
    if ($('#cfgPassword').value) body.obs.password = $('#cfgPassword').value;
    await fetch('/api/config', { method: 'PUT', body: JSON.stringify(body) });
    $('#cfgPassword').value = ''; $('#cfgObsMsg').textContent = 'Reconectando…';
  });
  for (const [id, key] of [['#cfgObsInvisivel', 'invisivel'], ['#cfgObsAuto', 'autoAbrir']]) $(id).addEventListener('change', () => fetch('/api/config', { method: 'PUT', body: JSON.stringify({ obs: { [key]: $(id).checked } }) }));
  $('#obsClose').addEventListener('click', async () => {
    if (!confirm('Fechar o OBS? As câmeras param de entrar na transmissão até abrir de novo.')) return;
    try { const r = await (await fetch('/api/obs/fechar', { method: 'POST' })).json(); if (r.error) throw new Error(r.error); toast(r.closed ? 'OBS fechado' : 'O OBS não fechou; feche pela bandeja do Windows.', !r.closed); }
    catch (e) { toast(e.message, true); }
    setTimeout(refreshObsLocal, 1500);
  });

  // ---- Qualidade da transmissão
  const QD_PRESETS = { leve: { largura: 1280, altura: 720, fps: 30, bitrate: 2500, encoder: 'x264' }, padrao: { largura: 1920, altura: 1080, fps: 30, bitrate: 4500, encoder: 'hw' }, alta: { largura: 1920, altura: 1080, fps: 60, bitrate: 6000, encoder: 'hw' } };
  const QD_NOMES = { nvenc: 'Placa NVIDIA (NVENC)', qsv: 'Intel QuickSync', amd: 'Placa AMD' };
  let qd = null;
  async function refreshSaida() {
    try { qd = await (await fetch('/api/obs/saida')).json(); } catch { return; }
    const enc = $('#qdEnc'); const cur = enc.value; enc.innerHTML = '<option value="x264">Processador (x264)</option>';
    for (const h of qd.hardware || []) enc.append(el('option', { value: h, text: QD_NOMES[h] || h }));
    if ([...enc.options].some((o) => o.value === cur)) enc.value = cur;
    const p = qd.perfil, v = qd.video;
    const partes = [];
    if (v) partes.push(`saída ${v.outputWidth}×${v.outputHeight} a ${Math.round(v.fpsNumerator / (v.fpsDenominator || 1))} fps`);
    else if (p && p.largura) partes.push(`saída ${p.largura}×${p.altura} a ${p.fps} fps`);
    if (p && p.bitrate) partes.push(`${p.bitrate} kbps`);
    if (p && p.encoder) partes.push(p.encoderNome);
    $('#qdAtual').textContent = partes.length ? 'Agora: ' + partes.join(' · ') + (p && p.modo === 'Advanced' ? ' (modo avançado no OBS; "Aplicar" muda para o modo simples)' : '') : (qd.perfil ? 'Perfil do OBS sem qualidade definida ainda.' : 'OBS ainda não tem perfil neste computador (abre uma vez para criar).');
    $('#qdReiniciar').hidden = !(qd.pendente && qd.running);
    if (qd.pendente && qd.running) $('#qdMsg').textContent = 'Taxa de bits e codificador novos esperam o OBS reiniciar.';
  }
  for (const b of $$('#tab-config [data-preset]')) b.addEventListener('click', () => {
    const p = QD_PRESETS[b.dataset.preset]; $('#qdRes').value = p.largura + 'x' + p.altura; $('#qdFps').value = String(p.fps); $('#qdBitrate').value = p.bitrate;
    $('#qdEnc').value = p.encoder === 'hw' ? ((qd && qd.hardware && qd.hardware[0]) || 'x264') : p.encoder;
  });
  $('#qdAplicar').addEventListener('click', async () => {
    const [largura, altura] = $('#qdRes').value.split('x').map(Number);
    const body = { largura, altura, fps: Number($('#qdFps').value), bitrate: Number($('#qdBitrate').value), encoder: $('#qdEnc').value };
    $('#qdMsg').textContent = 'Aplicando…';
    try {
      const r = await (await fetch('/api/obs/saida', { method: 'PUT', body: JSON.stringify(body) })).json();
      // o PUT devolve o estado novo; a resposta do que foi aplicado vem junto no GET seguinte
      await refreshSaida();
      const x = r.resultado || {};
      $('#qdMsg').textContent = x.pendente ? 'Resolução e fps já valem. Taxa de bits e codificador valem quando o OBS reiniciar (botão ao lado).' : (x.erro ? 'Erro: ' + x.erro : 'Qualidade aplicada: ' + (x.aplicado || []).join(' + ') + (x.avisoVideo ? '. ' + x.avisoVideo : '.'));
    } catch (e) { $('#qdMsg').textContent = 'Erro: ' + e.message; }
  });
  $('#qdReiniciar').addEventListener('click', async () => {
    $('#qdMsg').textContent = 'Reiniciando o OBS…';
    try { const r = await (await fetch('/api/obs/reiniciar', { method: 'POST' })).json(); if (r.error) throw new Error(r.error); $('#qdMsg').textContent = 'OBS reiniciado com a qualidade nova. Conectando…'; }
    catch (e) { $('#qdMsg').textContent = 'Erro: ' + e.message; }
    setTimeout(refreshSaida, 8000);
  });

  // ---- Fontes (webcams, microfones): o operador não precisa abrir o OBS
  const FT_TIPOS = { dshow_input: ['📷', 'Webcam', 'video_device_id'], wasapi_input_capture: ['🎤', 'Microfone', 'device_id'], wasapi_output_capture: ['🔊', 'Som do PC', 'device_id'], browser_source: ['🌐', 'Página', null], monitor_capture: ['🖥️', 'Tela', 'monitor_id'], ffmpeg_source: ['🎞️', 'Vídeo', null], image_source: ['🖼️', 'Imagem', null], color_source: ['🎨', 'Cor', null], text_gdiplus: ['🔤', 'Texto', null], text_gdiplus_v2: ['🔤', 'Texto', null], text_gdiplus_v3: ['🔤', 'Texto', null] };
  async function refreshFontes() {
    const box = $('#ftList');
    if (!S.obs) { box.innerHTML = '<p class="muted">Conecte o OBS para ver as fontes.</p>'; return; }
    try {
      const inputs = (await obs('GetInputList')).inputs;
      const scenes = S.scenes.length ? S.scenes : (await obs('GetSceneList')).scenes.map((x) => x.sceneName);
      const em = {}; // input -> cenas
      const lists = await obsBatch(scenes.map((sceneName) => ({ request: 'GetSceneItemList', data: { sceneName } })));
      lists.forEach((r, i) => { if (r.ok) for (const it of r.data.sceneItems) (em[it.sourceName] = em[it.sourceName] || []).push(scenes[i]); });
      box.innerHTML = '';
      if (!inputs.length) box.innerHTML = '<p class="muted">Nenhuma fonte ainda. Adicione uma webcam abaixo.</p>';
      for (const inp of inputs) {
        const [icone, tipo, prop] = FT_TIPOS[inp.inputKind] || ['▫️', inp.inputKind, null];
        const row = el('div', { class: 'fonte' }, [
          el('div', { class: 'ft-head' }, [el('span', { class: 'ft-icone', text: icone }), el('b', { text: inp.inputName }), el('span', { class: 'muted', text: tipo + ((em[inp.inputName] || []).length ? ' · em: ' + em[inp.inputName].join(', ') : ' · em nenhuma cena') })]),
        ]);
        const acts = el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' });
        if (prop) {
          const sel = el('select', { class: 'small' }, [el('option', { value: '', text: 'Carregando dispositivos…' })]);
          acts.append(sel);
          (async () => {
            try {
              const [items, cur] = await Promise.all([obs('GetInputPropertiesListPropertyItems', { inputName: inp.inputName, propertyName: prop }), obs('GetInputSettings', { inputName: inp.inputName })]);
              sel.innerHTML = '';
              sel.append(el('option', { value: '', text: '— escolher dispositivo —' }));
              for (const it of items.propertyItems) sel.append(el('option', { value: String(it.itemValue), text: it.itemName + (it.itemEnabled === false ? ' (indisponível)' : '') }));
              const v = cur.inputSettings[prop]; if (v !== undefined && [...sel.options].some((o) => o.value === String(v))) sel.value = String(v);
              sel.addEventListener('change', async () => { try { await obs('SetInputSettings', { inputName: inp.inputName, inputSettings: { [prop]: isNaN(sel.value) || sel.value === '' ? sel.value : Number(sel.value) }, overlay: true }); toast('Dispositivo trocado'); } catch (e) { toast(e.message, true); } });
            } catch { sel.innerHTML = '<option value="">(sem lista de dispositivos)</option>'; }
          })();
        }
        if (/wasapi|audio/.test(inp.inputKind)) {
          const mute = el('button', { class: 'small', text: '🔇 Mudo' , onclick: async () => { try { const m = await obs('GetInputMute', { inputName: inp.inputName }); await obs('SetInputMute', { inputName: inp.inputName, inputMuted: !m.inputMuted }); toast(!m.inputMuted ? 'No mudo' : 'Som ligado'); } catch (e) { toast(e.message, true); } } });
          acts.append(mute);
        }
        if (inp.inputName !== 'Overlay (legendas)') acts.append(el('button', { class: 'small danger ghost', text: 'Remover', onclick: async () => {
          if (!confirm(`Remover "${inp.inputName}" do OBS?`)) return;
          try { await obs('RemoveInput', { inputName: inp.inputName }); toast('Removida'); setTimeout(refreshFontes, 500); } catch (e) { toast(e.message, true); }
        } }));
        row.append(acts); box.append(row);
      }
    } catch (e) { box.innerHTML = '<p class="muted">Não consegui listar: ' + e.message + '</p>'; }
  }
  $('#ftRefresh').addEventListener('click', refreshFontes);
  $('#ftAdd').addEventListener('click', async () => {
    if (!S.obs) return toast('Conecte o OBS primeiro', true);
    const nome = $('#ftNome').value.trim(); const kind = $('#ftTipo').value; const msg = $('#ftMsg');
    if (!nome) return toast('Dê um nome à fonte', true);
    msg.textContent = 'Criando…';
    try {
      const scenes = (await obs('GetSceneList')).scenes.map((x) => x.sceneName);
      const inputs = (await obs('GetInputList')).inputs.map((i) => i.inputName);
      if (inputs.includes(nome) || scenes.includes(nome)) throw new Error('Já existe uma fonte ou cena com esse nome');
      const W = (S.info && S.info.viewWidth) || 1920, H = (S.info && S.info.viewHeight) || 1080;
      if (kind === 'wasapi_input_capture') {
        // microfone: entra em todas as cenas (menos Overlay), para o som não depender da cena
        const alvo = scenes.filter((n) => n !== 'Overlay');
        if (!alvo.length) throw new Error('Crie uma cena ou webcam antes do microfone');
        await obs('CreateInput', { sceneName: alvo[0], inputName: nome, inputKind: kind, inputSettings: {} });
        for (const sc of alvo.slice(1)) await obs('CreateSceneItem', { sceneName: sc, sourceName: nome });
        msg.textContent = 'Microfone criado em ' + alvo.length + ' cena(s). Escolha o dispositivo na lista acima.';
      } else {
        // webcam/tela: cena própria com o mesmo nome, overlay por cima e microfones existentes
        await obs('CreateScene', { sceneName: nome });
        const r = await obs('CreateInput', { sceneName: nome, inputName: nome, inputKind: kind, inputSettings: kind === 'monitor_capture' ? { monitor_id: 0 } : {} });
        try { await obs('SetSceneItemTransform', { sceneName: nome, sceneItemId: r.sceneItemId, sceneItemTransform: { positionX: 0, positionY: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: W, boundsHeight: H } }); } catch { /* ignorar */ }
        const all = (await obs('GetInputList')).inputs;
        for (const i of all) if (i.inputKind === 'wasapi_input_capture') { try { await obs('CreateSceneItem', { sceneName: nome, sourceName: i.inputName }); } catch { /* ignorar */ } }
        if (scenes.includes('Overlay')) { try { await obs('CreateSceneItem', { sceneName: nome, sourceName: 'Overlay' }); } catch { /* ignorar */ } }
        msg.textContent = `Cena "${nome}" criada. Escolha o dispositivo na lista acima.`;
      }
      $('#ftNome').value = '';
      setTimeout(refreshFontes, 600);
    } catch (e) { msg.textContent = ''; toast('Não criou: ' + e.message, true); }
  });

  // ---- Telas compostas: duas fontes na mesma cena (lado a lado, principal + canto, principal + faixa)
  const TL_VISUAIS = ['dshow_input', 'browser_source', 'monitor_capture', 'window_capture', 'game_capture', 'ffmpeg_source', 'image_source', 'vlc_source', 'ndi_source', 'decklink-input'];
  async function refreshTelas() {
    if (!S.obs) { $('#tlLista').innerHTML = '<p class="muted">Conecte o OBS.</p>'; return; }
    try {
      const inputs = (await obs('GetInputList')).inputs.filter((i) => TL_VISUAIS.includes(i.inputKind) && i.inputName !== 'Overlay (legendas)');
      for (const id of ['#tlA', '#tlB']) {
        const sel = $(id); const cur = sel.value; sel.innerHTML = '';
        for (const i of inputs) sel.append(el('option', { value: i.inputName, text: i.inputName }));
        if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
      }
      if ($('#tlB').options.length > 1 && $('#tlA').value === $('#tlB').value) $('#tlB').selectedIndex = 1;
      const box = $('#tlLista'); box.innerHTML = '';
      for (const sc of S.scenes.filter((n) => n !== 'Overlay')) {
        box.append(el('div', { class: 'rp-item' + (sc === S.program ? ' onair' : '') }, [
          el('span', { class: 'nome', text: sc }),
          el('button', { class: 'small', text: '👁 Ver', onclick: () => setScene(sc) }),
          el('button', { class: 'small danger ghost', text: 'Remover', onclick: async () => {
            if (!confirm(`Remover a cena "${sc}" do OBS? As fontes continuam existindo.`)) return;
            try { await obs('RemoveScene', { sceneName: sc }); toast('Cena removida'); } catch (e) { toast(e.message, true); }
          } }),
        ]));
      }
      if (!inputs.length) $('#tlMsg').textContent = 'Nenhuma fonte de vídeo ainda: adicione webcams na aba Fontes ou conecte celulares.';
    } catch (e) { toast(e.message, true); }
  }
  for (const r of $$('input[name="tlArr"]')) r.addEventListener('change', () => { $('#tlPipOpts').style.display = r.value === 'pip' && r.checked ? '' : 'none'; });
  $('#tlRefresh').addEventListener('click', refreshTelas);
  $('#tlCriar').addEventListener('click', async () => {
    if (!S.obs) return toast('Conecte o OBS primeiro', true);
    const nome = $('#tlNome').value.trim(), a = $('#tlA').value, b = $('#tlB').value, arr = $('input[name="tlArr"]:checked').value, msg = $('#tlMsg');
    if (!nome) return toast('Dê um nome à tela', true);
    if (!a || !b) return toast('Escolha as duas fontes', true);
    if (a === b) return toast('Escolha fontes diferentes', true);
    const W = (S.info && S.info.viewWidth) || 1920, H = (S.info && S.info.viewHeight) || 1080, M = Math.round(W * 0.02);
    msg.textContent = 'Montando…';
    try {
      if (S.scenes.includes(nome)) throw new Error('Já existe uma cena com esse nome');
      await obs('CreateScene', { sceneName: nome });
      // caixa de cada fonte: { x, y, w, h }; a fonte é ajustada por dentro da caixa e recortada para preencher
      let boxA, boxB;
      if (arr === 'lado') { boxA = { x: 0, y: 0, w: W / 2, h: H }; boxB = { x: W / 2, y: 0, w: W / 2, h: H }; }
      else if (arr === 'faixa') { const hb = Math.round(H * 0.3); boxA = { x: 0, y: 0, w: W, h: H - hb }; boxB = { x: 0, y: H - hb, w: W, h: hb }; }
      else {
        const t = Number($('#tlTam').value), c = $('#tlCanto').value; const bw = Math.round(W * t), bh = Math.round(bw * 9 / 16);
        boxA = { x: 0, y: 0, w: W, h: H };
        boxB = { x: c.startsWith('dir') ? W - bw - M : M, y: c.endsWith('cima') ? M : H - bh - M, w: bw, h: bh };
      }
      const place = async (fonte, box, preencher) => {
        const r = await obs('CreateSceneItem', { sceneName: nome, sourceName: fonte });
        const t = { positionX: box.x, positionY: box.y, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: box.w, boundsHeight: box.h, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };
        if (preencher) {
          // recorta a fonte na proporção da caixa, para encher sem faixas pretas
          try {
            const cur = (await obs('GetSceneItemTransform', { sceneName: nome, sceneItemId: r.sceneItemId })).sceneItemTransform;
            const sw = cur.sourceWidth, sh = cur.sourceHeight;
            if (sw > 0 && sh > 0) {
              const alvo = box.w / box.h, atual = sw / sh;
              if (atual > alvo) { const cw = sh * alvo; t.cropLeft = t.cropRight = Math.round((sw - cw) / 2); }
              else if (atual < alvo) { const ch = sw / alvo; t.cropTop = t.cropBottom = Math.round((sh - ch) / 2); }
            }
          } catch { /* sem tamanho da fonte: fica com faixas */ }
        }
        await obs('SetSceneItemTransform', { sceneName: nome, sceneItemId: r.sceneItemId, sceneItemTransform: t });
      };
      await place(a, boxA, arr !== 'pip');
      await place(b, boxB, arr !== 'pip');
      const all = (await obs('GetInputList')).inputs;
      for (const i of all) if (i.inputKind === 'wasapi_input_capture') { try { await obs('CreateSceneItem', { sceneName: nome, sourceName: i.inputName }); } catch { /* ignorar */ } }
      if (S.scenes.includes('Overlay')) { try { await obs('CreateSceneItem', { sceneName: nome, sourceName: 'Overlay' }); } catch { /* ignorar */ } }
      msg.textContent = `Tela "${nome}" criada. Ela já aparece nas cenas.`;
      $('#tlNome').value = '';
      setTimeout(refreshTelas, 600);
    } catch (e) { msg.textContent = ''; toast('Não criou: ' + e.message, true); }
  });

  // ---- Player de vídeos (playlist numa fonte de mídia do OBS)
  async function plPost(acao, body) {
    try {
      const r = await (await fetch('/api/player/' + acao, { method: 'POST', body: JSON.stringify(body || {}) })).json();
      if (r.error) throw new Error(r.error);
      return r;
    } catch (e) { toast('Vídeo: ' + e.message, true); }
  }
  function fmtTempo(s) { s = Math.max(0, Math.round(Number(s) || 0) / 1000); const m = Math.floor(s / 60), x = Math.floor(s % 60); return m + ':' + String(x).padStart(2, '0'); }
  let plVolEditing = false, plVolTimer = null;
  function renderPlayer() {
    const st = S.player; if (!st) return;
    const b = $('#plState');
    if (st.tocando) { b.className = 'badge ' + (st.pausado ? 'warn' : 'live'); b.textContent = st.pausado ? 'PAUSADO' : 'NO AR'; }
    else { b.className = 'badge'; b.textContent = st.conectado ? 'parado' : 'OBS desconectado'; }
    const agora = $('#plAgora'); agora.innerHTML = '';
    if (st.tocando && st.item) agora.append(el('b', { text: st.item.nome }), el('div', { class: 'muted', style: 'font-size:12px', text: st.item.arquivo }));
    else agora.append(el('span', { class: 'muted', text: st.itens.length ? 'Nenhum vídeo tocando. Clique em ▶ num vídeo da lista.' : 'Nenhum vídeo tocando.' }));
    const dur = st.status.duracao || 0, cur = st.status.cursor || 0;
    $('#plBar').style.width = (st.tocando && dur ? Math.min(100, cur / dur * 100) : 0) + '%';
    $('#plTempo').textContent = st.tocando ? `${fmtTempo(cur)} / ${fmtTempo(dur)}` : '0:00 / 0:00';
    $('#plAnterior').textContent = st.tocando && st.cenaAnterior ? 'volta para: ' + st.cenaAnterior : '';
    $('#plPause').textContent = st.tocando && !st.pausado ? '⏸ Pausar' : '▶ ' + (st.tocando ? 'Continuar' : 'Tocar');
    $('#plPause').disabled = !st.conectado || (!st.tocando && !st.itens.length);
    $('#plNext').disabled = !st.conectado || st.itens.length < 2;
    $('#plStop').disabled = !st.tocando;
    $('#plFim').value = st.aoTerminar; $('#plMics').checked = !!st.silenciarMics;
    if (!plVolEditing) { $('#plVol').value = st.volume; $('#plVolVal').textContent = st.volume; }
    const box = $('#plLista'); box.innerHTML = '';
    st.itens.forEach((it, i) => {
      const onair = st.tocando && st.atual === i;
      box.append(el('div', { class: 'rp-item' + (onair ? ' onair' : '') }, [
        el('button', { class: 'small' + (onair ? ' primary' : ''), text: onair ? (st.pausado ? '⏸' : '▶ NO AR') : '▶', title: 'Tocar este vídeo', onclick: () => plPost('tocar', { id: it.id }) }),
        el('span', { class: 'nome' }, [el('b', { text: it.nome }), ' ', el('span', { class: 'muted', style: 'font-size:12px', text: it.origem === 'upload' ? '· enviado' : '· ' + it.arquivo })]),
        el('button', { class: 'small ghost', text: '▲', onclick: () => fetch('/api/player/itens', { method: 'PUT', body: JSON.stringify({ id: it.id, dir: -1 }) }) }),
        el('button', { class: 'small ghost', text: '▼', onclick: () => fetch('/api/player/itens', { method: 'PUT', body: JSON.stringify({ id: it.id, dir: 1 }) }) }),
        el('button', { class: 'small ghost danger', text: '✕', title: 'Tirar da lista', onclick: () => { if (confirm(`Tirar "${it.nome}" da lista?` + (it.origem === 'upload' ? ' O arquivo enviado será apagado.' : ''))) fetch('/api/player/itens', { method: 'DELETE', body: JSON.stringify({ id: it.id }) }); } }),
      ]));
    });
    if (!st.itens.length) box.append(el('p', { class: 'muted', text: 'Lista vazia. Envie um vídeo ou informe o caminho de um que já está no PC.' }));
  }
  $('#plPause').addEventListener('click', () => { const st = S.player; if (!st) return; plPost(st.tocando && !st.pausado ? 'pausar' : 'continuar'); });
  $('#plNext').addEventListener('click', () => plPost('proximo'));
  $('#plStop').addEventListener('click', () => plPost('parar'));
  $('#plFim').addEventListener('change', () => fetch('/api/player/opcoes', { method: 'PUT', body: JSON.stringify({ aoTerminar: $('#plFim').value }) }));
  $('#plMics').addEventListener('change', () => fetch('/api/player/opcoes', { method: 'PUT', body: JSON.stringify({ silenciarMics: $('#plMics').checked }) }));
  $('#plVol').addEventListener('input', () => { plVolEditing = true; $('#plVolVal').textContent = $('#plVol').value; clearTimeout(plVolTimer); plVolTimer = setTimeout(() => { plVolEditing = false; fetch('/api/player/opcoes', { method: 'PUT', body: JSON.stringify({ volume: Number($('#plVol').value) }) }); }, 250); });
  $('#plUpload').addEventListener('click', () => $('#plArquivo').click());
  $('#plArquivo').addEventListener('change', async () => {
    const msg = $('#plMsg');
    for (const f of $('#plArquivo').files) {
      try {
        msg.textContent = `Enviando ${f.name} (${(f.size / 1e6).toFixed(0)} MB)… não feche a mesa.`;
        const r = await (await fetch('/api/videos', { method: 'POST', headers: { 'x-nome': encodeURIComponent(f.name), 'Content-Type': 'application/octet-stream' }, body: f })).json();
        if (r.error) throw new Error(r.error);
        const a = await (await fetch('/api/player/itens', { method: 'POST', body: JSON.stringify({ nome: f.name.replace(/\.[^.]+$/, ''), arquivo: r.arquivo, origem: 'upload' }) })).json();
        if (a.error) throw new Error(a.error);
        toast(`Na lista: ${a.item.nome}`);
      } catch (e) { toast('Não enviou ' + f.name + ': ' + e.message, true); }
    }
    msg.textContent = 'Os vídeos enviados ficam na pasta data/videos. Para vídeos grandes, use o caminho.';
    $('#plArquivo').value = '';
  });
  $('#plAddCaminho').addEventListener('click', async () => {
    const caminho = $('#plCaminho').value.trim(); if (!caminho) return;
    const a = await (await fetch('/api/player/itens', { method: 'POST', body: JSON.stringify({ arquivo: caminho, origem: 'caminho' }) })).json();
    if (a.error) return toast(a.error, true);
    $('#plCaminho').value = ''; toast(`Na lista: ${a.item.nome}`);
  });

  // ---- Gráficos: tema, logo, QR, relógio (persistentes em config.graficos) e imagens
  const CANTOS = { 'esq-cima': 'Esquerda, em cima', 'dir-cima': 'Direita, em cima', 'esq-baixo': 'Esquerda, embaixo', 'dir-baixo': 'Direita, embaixo' };
  for (const sel of $$('.canto-sel')) for (const [k, v] of Object.entries(CANTOS)) sel.append(el('option', { value: k, text: v }));
  let grEditing = false, grTimer = null;
  async function grSet(patch) {
    try {
      const r = await (await fetch('/api/graficos', { method: 'PUT', body: JSON.stringify(patch) })).json();
      if (r.error) throw new Error(r.error);
      if (S.config) { S.config.graficos = r.graficos; renderGrConfig(); }
    } catch (e) { toast('Não consegui salvar: ' + e.message, true); }
  }
  function grSetLento(patch) { clearTimeout(grTimer); grTimer = setTimeout(() => grSet(patch), 300); }
  function renderGrConfig() {
    const g = S.config && S.config.graficos; if (!g) return;
    if (grEditing) return;
    $('#tmCor').value = g.tema.cor; $('#tmFonte').value = g.tema.fonte; if (!$('#tmFonte').value) $('#tmFonte').value = 'Segoe UI';
    $('#tmEstilo').value = g.tema.estilo; $('#tmLowerPos').value = g.tema.lowerPos; renderTmPreview();
    $('#lgImagem').value = g.logo.arquivo || ''; $('#lgCanto').value = g.logo.canto; $('#lgTam').value = g.logo.tamanho; $('#lgTamVal').textContent = g.logo.tamanho; $('#lgOp').value = g.logo.opacidade; $('#lgOpVal').textContent = g.logo.opacidade; $('#lgVisible').checked = !!g.logo.visible;
    $('#qrTexto').value = g.qr.texto; $('#qrRotulo').value = g.qr.rotulo; $('#qrCanto').value = g.qr.canto; $('#qrTam').value = g.qr.tamanho; $('#qrTamVal').textContent = g.qr.tamanho; $('#qrVisible').checked = !!g.qr.visible;
    const pv = $('#qrPreview'); if (g.qr.texto) { pv.src = '/qr.svg?text=' + encodeURIComponent(g.qr.texto); pv.style.display = ''; } else pv.style.display = 'none';
    $('#rlCanto').value = g.relogio.canto; $('#rlFormato').value = g.relogio.formato; $('#rlVisible').checked = !!g.relogio.visible;
  }
  function renderTmPreview() {
    const p = $('#tmPreview');
    p.className = 'tm-preview ' + $('#tmEstilo').value + ($('#tmLowerPos').value === 'centro' ? ' centro' : '');
    p.style.setProperty('--accent', $('#tmCor').value); p.style.fontFamily = `"${$('#tmFonte').value}", sans-serif`;
  }
  for (const id of ['#tmCor', '#tmFonte', '#tmEstilo', '#tmLowerPos', '#qrTexto', '#qrRotulo', '#lgTam', '#lgOp', '#qrTam']) {
    $(id).addEventListener('focus', () => { grEditing = true; }); $(id).addEventListener('blur', () => { grEditing = false; });
  }
  $('#tmCor').addEventListener('input', () => { renderTmPreview(); grSetLento({ tema: { cor: $('#tmCor').value } }); });
  $('#tmFonte').addEventListener('change', () => { renderTmPreview(); grSet({ tema: { fonte: $('#tmFonte').value } }); });
  $('#tmEstilo').addEventListener('change', () => { renderTmPreview(); grSet({ tema: { estilo: $('#tmEstilo').value } }); });
  $('#tmLowerPos').addEventListener('change', () => { renderTmPreview(); grSet({ tema: { lowerPos: $('#tmLowerPos').value } }); });
  $('#lgImagem').addEventListener('change', () => grSet({ logo: { arquivo: $('#lgImagem').value, visible: !!$('#lgImagem').value && $('#lgVisible').checked } }));
  $('#lgCanto').addEventListener('change', () => grSet({ logo: { canto: $('#lgCanto').value } }));
  $('#lgTam').addEventListener('input', () => { $('#lgTamVal').textContent = $('#lgTam').value; grSetLento({ logo: { tamanho: Number($('#lgTam').value) } }); });
  $('#lgOp').addEventListener('input', () => { $('#lgOpVal').textContent = $('#lgOp').value; grSetLento({ logo: { opacidade: Number($('#lgOp').value) } }); });
  $('#lgVisible').addEventListener('change', () => { if ($('#lgVisible').checked && !$('#lgImagem').value) { $('#lgVisible').checked = false; return toast('Escolha a imagem da logo (envie em "Imagens")', true); } grSet({ logo: { visible: $('#lgVisible').checked } }); });
  $('#qrTexto').addEventListener('change', () => grSet({ qr: { texto: $('#qrTexto').value } }));
  $('#qrRotulo').addEventListener('change', () => grSet({ qr: { rotulo: $('#qrRotulo').value } }));
  $('#qrCanto').addEventListener('change', () => grSet({ qr: { canto: $('#qrCanto').value } }));
  $('#qrTam').addEventListener('input', () => { $('#qrTamVal').textContent = $('#qrTam').value; grSetLento({ qr: { tamanho: Number($('#qrTam').value) } }); });
  $('#qrVisible').addEventListener('change', () => { if ($('#qrVisible').checked && !$('#qrTexto').value.trim()) { $('#qrVisible').checked = false; return toast('Escreva o conteúdo do QR primeiro', true); } grSet({ qr: { visible: $('#qrVisible').checked, texto: $('#qrTexto').value, rotulo: $('#qrRotulo').value } }); });
  $('#rlCanto').addEventListener('change', () => grSet({ relogio: { canto: $('#rlCanto').value } }));
  $('#rlFormato').addEventListener('change', () => grSet({ relogio: { formato: $('#rlFormato').value } }));
  $('#rlVisible').addEventListener('change', () => grSet({ relogio: { visible: $('#rlVisible').checked } }));

  async function refreshImagens() {
    try { S.imagens = (await (await fetch('/api/imagens')).json()).imagens || []; } catch { return; }
    for (const id of ['#lgImagem', '#ctImagem']) {
      const sel = $(id), cur = sel.value; sel.innerHTML = `<option value="">${id === '#lgImagem' ? '(nenhuma)' : '(cor do tema)'}</option>`;
      for (const i of S.imagens) sel.append(el('option', { value: i.nome, text: i.nome }));
      sel.value = cur; if (sel.value !== cur) sel.value = '';
    }
    const box = $('#imLista'); box.innerHTML = '';
    for (const i of S.imagens) {
      box.append(el('div', { class: 'im-item' }, [
        el('img', { src: i.url, alt: i.nome, loading: 'lazy' }),
        el('div', { class: 'nome', text: i.nome }),
        el('div', { class: 'row', style: 'gap:4px' }, [
          el('button', { class: 'small', text: 'Logo', title: 'Usar como logo', onclick: () => { $('#lgImagem').value = i.nome; grSet({ logo: { arquivo: i.nome, visible: true } }); } }),
          el('button', { class: 'small', text: 'Fundo', title: 'Usar como fundo do cartão', onclick: () => { $('#ctImagem').value = i.nome; } }),
          el('button', { class: 'small ghost danger', text: '✕', title: 'Apagar', onclick: async () => { if (!confirm(`Apagar "${i.nome}"?`)) return; await fetch('/api/imagens', { method: 'DELETE', body: JSON.stringify({ nome: i.nome }) }); refreshImagens(); } }),
        ]),
      ]));
    }
    if (!S.imagens.length) box.append(el('p', { class: 'muted', text: 'Nenhuma imagem ainda. Envie a logo da igreja e fundos para os cartões.' }));
    renderGrConfig();
  }
  $('#imUpload').addEventListener('click', () => $('#imArquivo').click());
  $('#imArquivo').addEventListener('change', async () => {
    for (const f of $('#imArquivo').files) {
      try {
        const r = await (await fetch('/api/imagens', { method: 'POST', headers: { 'x-nome': encodeURIComponent(f.name), 'Content-Type': 'application/octet-stream' }, body: f })).json();
        if (r.error) throw new Error(r.error);
        toast(`Enviada: ${r.nome}`);
      } catch (e) { toast('Não enviou ' + f.name + ': ' + e.message, true); }
    }
    $('#imArquivo').value = ''; refreshImagens();
  });

  // ---- Transições na coleção do OBS (estinger etc.): mudam o arquivo da coleção e reiniciam o OBS
  async function refreshTransicoes() {
    try { S.tsInfo = await (await fetch('/api/transicoes')).json(); } catch (e) { toast(e.message, true); return; }
    const sel = $('#tnEnviados'); const cur = sel.value; sel.innerHTML = '<option value="">(enviar um novo)</option>';
    for (const e of S.tsInfo.estingers || []) sel.append(el('option', { value: e.arquivo, text: e.nome }));
    sel.value = cur;
    renderTsColecao();
  }
  function renderTsColecao() {
    const box = $('#tsColecao'); box.innerHTML = '';
    const info = S.tsInfo, pend = S.tsPend;
    if (!info) return;
    if (!info.colecao) box.append(el('p', { class: 'muted', text: info.obsInstalado ? 'Coleção de cenas do OBS não encontrada: abra o OBS uma vez.' : 'OBS não encontrado neste computador.' }));
    else {
      box.append(el('div', { class: 'muted', style: 'font-size:12px', text: `Coleção "${info.colecao.colecao}" · padrão: ${info.colecao.atual || '(do OBS)'} · ${info.colecao.duracao} ms` }));
      for (const t of info.colecao.transicoes) {
        const rem = pend.remover.includes(t.nome);
        box.append(el('div', { class: 'rp-item' + (rem ? ' off' : '') }, [
          el('span', { class: 'nome' }, [el('b', { text: t.nome }), ' ', el('span', { class: 'muted', text: '· ' + ((info.tipos[t.tipo] || {}).nome || t.tipo) + (t.settings.path ? ' · ' + t.settings.path.split(/[\\/]/).pop() : '') + (rem ? ' · será removida' : '') })]),
          el('button', { class: 'small ghost' + (rem ? '' : ' danger'), text: rem ? 'Manter' : 'Remover', onclick: () => { pend.remover = rem ? pend.remover.filter((n) => n !== t.nome) : [...pend.remover, t.nome]; renderTsColecao(); } }),
        ]));
      }
    }
    for (const a of pend.adicionar) {
      box.append(el('div', { class: 'rp-item novo' }, [
        el('span', { class: 'nome' }, [el('b', { text: a.nome }), ' ', el('span', { class: 'muted', text: '· ' + (TN_TIPOS[a.tipo] || a.tipo) + (a.arquivo ? ' · ' + a.arquivo.split(/[\\/]/).pop() : '') + ' · nova' })]),
        el('button', { class: 'small ghost', text: 'Tirar', onclick: () => { pend.adicionar = pend.adicionar.filter((x) => x !== a); renderTsColecao(); } }),
      ]));
    }
    const temPend = pend.adicionar.length || pend.remover.length;
    $('#tsPendBadge').style.display = temPend ? '' : 'none'; $('#tsAplicar').disabled = !temPend || !info.colecao; $('#tsDescartar').disabled = !temPend;
  }
  const TN_TIPOS = { estinger: 'Estinger (vídeo)', fadecor: 'Esmaecer para cor', deslizar: 'Deslizar', varrer: 'Varrer' };
  function tnTipoUI() {
    const t = $('#tnTipo').value;
    $('#tnEstinger').style.display = t === 'estinger' ? '' : 'none';
    $('#tnFadecor').style.display = t === 'fadecor' ? '' : 'none';
    $('#tnDirecao').style.display = (t === 'deslizar' || t === 'varrer') ? '' : 'none';
  }
  $('#tnTipo').addEventListener('change', tnTipoUI);
  $('#tnArquivo').addEventListener('change', () => {
    const f = $('#tnArquivo').files[0], v = $('#tnPreview');
    if (!f) { v.style.display = 'none'; return; }
    v.src = URL.createObjectURL(f); v.style.display = ''; $('#tnEnviados').value = '';
    if (!$('#tnNome').value.trim()) $('#tnNome').value = f.name.replace(/\.[^.]+$/, '');
  });
  $('#tnEnviados').addEventListener('change', () => {
    const v = $('#tnPreview'), e = (S.tsInfo && S.tsInfo.estingers || []).find((x) => x.arquivo === $('#tnEnviados').value);
    if (!e) { v.style.display = 'none'; return; }
    $('#tnArquivo').value = ''; v.src = e.url; v.style.display = '';
    if (!$('#tnNome').value.trim()) $('#tnNome').value = e.nome.replace(/\.[^.]+$/, '');
  });
  async function enviarEstinger(f, msg) {
    msg.textContent = `Enviando ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`;
    const r = await (await fetch('/api/transicoes/arquivo', { method: 'POST', headers: { 'x-nome': encodeURIComponent(f.name), 'Content-Type': 'application/octet-stream' }, body: f })).json();
    if (r.error) throw new Error(r.error);
    return r;
  }
  $('#tnAdd').addEventListener('click', async () => {
    const msg = $('#tnMsg'), tipo = $('#tnTipo').value, nome = $('#tnNome').value.trim();
    if (!nome) return toast('Dê um nome à transição', true);
    const spec = { tipo, nome };
    try {
      if (tipo === 'estinger') {
        const f = $('#tnArquivo').files[0];
        if (f) spec.arquivo = (await enviarEstinger(f, msg)).arquivo;
        else if ($('#tnEnviados').value) spec.arquivo = $('#tnEnviados').value;
        else return toast('Escolha o vídeo do estinger', true);
        spec.ponto = Number($('#tnPonto').value) || 0; spec.audio = $('#tnAudio').value;
      } else if (tipo === 'fadecor') { spec.cor = $('#tnCor').value; spec.ponto = Number($('#tnPontoCor').value) || 50; }
      else spec.direcao = $('#tnDir').value;
      S.tsPend.adicionar = S.tsPend.adicionar.filter((x) => x.nome !== nome); S.tsPend.adicionar.push(spec);
      msg.textContent = `"${nome}" na lista. Clique em "Aplicar e reiniciar o OBS" para valer.`;
      $('#tnNome').value = ''; $('#tnArquivo').value = ''; $('#tnEnviados').value = ''; $('#tnPreview').style.display = 'none';
      refreshTransicoes();
    } catch (e) { msg.textContent = ''; toast('Não deu: ' + e.message, true); }
  });
  $('#tsDescartar').addEventListener('click', () => { S.tsPend = { adicionar: [], remover: [] }; renderTsColecao(); });
  $('#tsAplicar').addEventListener('click', async () => {
    if (S.streaming) return toast('Pare a transmissão antes de mudar as transições', true);
    const msg = $('#tsMsg'); msg.textContent = 'Fechando o OBS, gravando a coleção e reabrindo… (uns 15 s)';
    $('#tsAplicar').disabled = true;
    try {
      const body = Object.assign({}, S.tsPend);
      const novo = body.adicionar[body.adicionar.length - 1]; if (novo && S.tsInfo && S.tsInfo.colecao && !S.tsInfo.colecao.transicoes.length) body.atual = novo.nome; // primeira transição nova vira a padrão
      const r = await (await fetch('/api/transicoes', { method: 'PUT', body: JSON.stringify(body) })).json();
      if (r.error) throw new Error(r.error);
      S.tsPend = { adicionar: [], remover: [] };
      msg.textContent = r.reabriu ? 'Pronto. O OBS está reabrindo; a nova transição aparece na lista em instantes.' : 'Pronto. Abra o OBS para a transição aparecer.';
      toast('Transições aplicadas');
      refreshTransicoes();
    } catch (e) { msg.textContent = ''; toast('Não aplicou: ' + e.message, true); renderTsColecao(); }
  });

  // ---- Tradução ao vivo
  const TR_IDIOMAS = { en: 'Inglês', es: 'Espanhol', fr: 'Francês', de: 'Alemão', it: 'Italiano', zh: 'Chinês', ja: 'Japonês', ko: 'Coreano', ru: 'Russo', ar: 'Árabe', nl: 'Holandês', pl: 'Polonês', uk: 'Ucraniano' };
  const TR_PROVEDORES = { anthropic: 'Claude (Anthropic) — precisa de chave, melhor qualidade', deepl: 'DeepL — precisa de chave (tem plano gratuito)', google: 'Google Tradutor — sem chave, sem garantia', nenhum: 'Nenhum — só o que foi falado, em português' };
  const TR_MODELOS = { 'claude-opus-5-5': 'Claude Opus 5.5 (melhor qualidade)', 'claude-sonnet-5-5': 'Claude Sonnet 5.5 (equilíbrio)', 'claude-haiku-5-5': 'Claude Haiku 5.5 (mais rápido e barato)' };
  const TR_DICAS = {
    anthropic: 'Crie a chave em console.anthropic.com → API Keys e coloque créditos na conta. Cada frase custa frações de centavo: um culto inteiro sai por centavos de dólar com o Haiku e por poucos dólares com o Opus.',
    deepl: 'Crie a conta em deepl.com/pro-api. O plano gratuito dá 500 mil caracteres por mês (uns 10 cultos); a chave gratuita termina em ":fx".',
    google: 'Usa o tradutor do Google sem chave. Costuma funcionar, mas o Google pode bloquear sem aviso. Bom para experimentar.',
    nenhum: 'Não traduz: mostra só o que foi falado, em português. Serve como legenda para quem tem dificuldade de audição.',
  };
  const TR_OUVINTE = { desconectado: ['danger', 'ouvinte desconectado'], conectado: ['warn', 'ouvinte aberto (parado)'], parado: ['warn', 'ouvinte parado'], ouvindo: ['ok', 'ouvindo 🎙️'], erro: ['danger', 'ouvinte com erro'] };
  let trEditing = false, trQrKey = '';
  async function trSet(patch) {
    try {
      const r = await (await fetch('/api/traducao', { method: 'PUT', body: JSON.stringify(patch) })).json();
      if (r.config) { S.config = r.config; renderTrConfig(); }
      if (r.state) { S.traducao = r.state; renderTr(); }
      return r;
    } catch (e) { toast('Não consegui salvar: ' + e.message, true); }
  }
  function trIdiomasMarcados() { return $$('#trIdiomas input:checked').map((i) => i.value); }
  function renderTrConfig() {
    const t = S.config && S.config.traducao; if (!t) return;
    $('#trAtivo').checked = !!t.ativo; $('#trNaLive').checked = !!t.naLive;
    if (!$('#trProvedor').options.length) for (const [k, v] of Object.entries(TR_PROVEDORES)) $('#trProvedor').append(el('option', { value: k, text: v }));
    if (!$('#trModelo').options.length) for (const [k, v] of Object.entries(TR_MODELOS)) $('#trModelo').append(el('option', { value: k, text: v }));
    if (!trEditing) { $('#trProvedor').value = t.provedor || 'anthropic'; $('#trModelo').value = t.modelo || 'claude-opus-5-5'; }
    $('#trChaveHint').textContent = t.hasChave ? '(já salva)' : '(nenhuma)';
    trProvedorUI();
    const box = $('#trIdiomas'); box.innerHTML = '';
    for (const [k, v] of Object.entries(TR_IDIOMAS)) {
      const inp = el('input', { type: 'checkbox', value: k, checked: (t.idiomas || []).includes(k) });
      inp.addEventListener('change', () => { const sel = trIdiomasMarcados(); if (!sel.length) { inp.checked = true; return toast('Deixe pelo menos um idioma', true); } trSet({ idiomas: sel }); });
      box.append(el('label', { class: 'tr-chip' + (inp.checked ? ' on' : '') }, [inp, v]));
    }
    const live = $('#trIdiomaLive'); live.innerHTML = '';
    for (const k of (t.idiomas || [])) live.append(el('option', { value: k, text: TR_IDIOMAS[k] || k }));
    live.value = t.idiomaLive; if (!live.value && live.options.length) live.selectedIndex = 0;
    $('#trLiveWrap').style.display = t.naLive ? '' : 'none';
    renderTr();
  }
  function trProvedorUI() {
    const p = $('#trProvedor').value;
    $('#trModeloWrap').style.display = p === 'anthropic' ? '' : 'none';
    $('#trChaveWrap').style.display = (p === 'anthropic' || p === 'deepl') ? '' : 'none';
    $('#trProvDica').textContent = TR_DICAS[p] || '';
  }
  function renderTrQr() {
    if (!S.info) return;
    const key = S.info.ips.map((x) => x.ip).join(',') + ':' + S.info.httpsPort; if (key === trQrKey) return; trQrKey = key;
    const box = $('#trQr'); box.innerHTML = '';
    for (const { ip, iface } of S.info.ips) {
      const url = `https://${ip}:${S.info.httpsPort}/traducao`;
      box.append(el('div', { class: 'qr' }, [el('img', { src: '/qr.svg?text=' + encodeURIComponent(url), width: 150, height: 150, alt: 'QR' }), el('div', { html: `<b>${iface}</b><br>${url}` })]));
    }
    if (!S.info.ips.length) box.innerHTML = '<span class="muted">Sem rede: conecte o PC ao Wi‑Fi da igreja.</span>';
  }
  function renderTr() {
    const st = S.traducao, t = (S.config && S.config.traducao) || {};
    const badge = $('#trBadge'); badge.hidden = !t.ativo;
    if (!st) return;
    const ouv = st.ouvinte || { estado: 'desconectado' };
    const [cls, label] = TR_OUVINTE[ouv.estado] || ['', ouv.estado];
    const ob = $('#trOuvinte'); ob.className = 'badge ' + cls; ob.textContent = label + (ouv.estado === 'erro' && ouv.erro ? ' · ' + ouv.erro : '');
    if (t.ativo) setBadge(badge, ouv.estado === 'ouvindo' ? (st.erro ? 'warn' : 'ok') : 'danger', 'Tradução');
    const c = st.contador || {};
    $('#trContador').textContent = (c.pedidos ? `${c.pedidos} frases · ${c.falhas || 0} falhas` : '') + (st.erro ? ' · ⚠ ' + st.erro : '') + (st.fila ? ` · ${st.fila} na fila` : '');
    renderTrAgora();
  }
  function renderTrAgora() {
    const st = S.traducao, box = $('#trAgora'), t = (S.config && S.config.traducao) || {};
    box.innerHTML = '';
    const hist = (st && st.historico) || [];
    if (!hist.length && !S.trParcial) { box.innerHTML = '<span class="muted">' + (t.ativo ? 'Nada reconhecido ainda. Abra o ouvinte e clique em "Começar a ouvir".' : 'Ligue a tradução acima.') + '</span>'; return; }
    for (const it of hist.slice(-3)) {
      const linhas = [el('div', { class: 'orig', text: it.original })];
      for (const [k, v] of Object.entries(it.traducoes || {})) if (v) linhas.push(el('div', { class: 'trad' }, [el('b', { text: (TR_IDIOMAS[k] || k) + ': ' }), v]));
      if (it.erro) linhas.push(el('div', { class: 'trad erro', text: '⚠ ' + it.erro }));
      box.append(el('div', { class: 'tr-item' }, linhas));
    }
    if (S.trParcial) box.append(el('div', { class: 'tr-parcial', text: '… ' + S.trParcial }));
  }
  $('#trAtivo').addEventListener('change', () => trSet({ ativo: $('#trAtivo').checked }));
  $('#trNaLive').addEventListener('change', () => trSet({ naLive: $('#trNaLive').checked }));
  $('#trIdiomaLive').addEventListener('change', () => trSet({ idiomaLive: $('#trIdiomaLive').value }));
  for (const id of ['#trProvedor', '#trModelo', '#trChave']) { $(id).addEventListener('focus', () => { trEditing = true; }); $(id).addEventListener('blur', () => { trEditing = false; }); }
  $('#trProvedor').addEventListener('change', trProvedorUI);
  $('#trSalvar').addEventListener('click', async () => {
    const r = await trSet({ provedor: $('#trProvedor').value, modelo: $('#trModelo').value, chave: $('#trChave').value });
    if (r) { $('#trChave').value = ''; trEditing = false; toast('Tradução salva'); }
  });
  $('#trTestar').addEventListener('click', async () => {
    const msg = $('#trTesteMsg'); msg.textContent = 'Traduzindo uma frase de teste…';
    try {
      const r = await (await fetch('/api/traducao/testar', { method: 'POST', body: JSON.stringify({ provedor: $('#trProvedor').value, modelo: $('#trModelo').value, chave: $('#trChave').value, idiomas: trIdiomasMarcados() }) })).json();
      msg.textContent = r.ok ? `Funcionou em ${(r.ms / 1000).toFixed(1)} s · ${TR_IDIOMAS[r.idioma] || r.idioma}: "${r.texto}"` : 'Falhou: ' + r.erro;
    } catch (e) { msg.textContent = 'Falhou: ' + e.message; }
  });
  $('#trAbrirOuvinte').addEventListener('click', async () => {
    const msg = $('#trMsg'); msg.textContent = 'Abrindo…';
    try {
      const r = await (await fetch('/api/traducao/abrir-ouvinte', { method: 'POST' })).json();
      msg.textContent = r.ok ? `Aberto no ${r.navegador}. Clique em "Começar a ouvir" se não começar sozinho.` : r.erro;
    } catch (e) { msg.textContent = e.message; }
  });
  $('#trLimpar').addEventListener('click', () => fetch('/api/traducao/limpar', { method: 'POST' }));

  $('#cfgSaveCams').addEventListener('click', async () => {
    await fetch('/api/config', { method: 'PUT', body: JSON.stringify({ cameraNames: $('#cfgCams').value.split('\n').map((s) => s.trim()).filter(Boolean) }) });
    toast('Nomes salvos'); loadInfo();
  });

  // ------------------------------------------------------------ abas, badges, toast
  for (const b of $$('.tabs button')) b.addEventListener('click', () => {
    if (b.dataset.tab === 'destinos') refreshRelayObs();
    for (const x of $$('.tabs button')) x.classList.toggle('active', x === b);
    for (const t of $$('.tab')) t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab);
    if (b.dataset.tab === 'audio') refreshAudio();
    if (b.dataset.tab === 'fontes') refreshFontes();
    if (b.dataset.tab === 'telas') refreshTelas();
    if (b.dataset.tab === 'config') refreshSaida();
    if (b.dataset.tab === 'traducao') renderTrQr();
    if (b.dataset.tab === 'transicoes') refreshTransicoes();
    if (b.dataset.tab === 'graficos') refreshImagens();
  });
  function setBadge(elm, cls, label) { elm.className = 'badge ' + cls; elm.innerHTML = `<span class="dot ${cls}"></span>${label}`; }
  let toastTimer;
  function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 3500); }

  renderRiFields(); renderStream(); renderRecord();
})();
