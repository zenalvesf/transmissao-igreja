/* Mesa de produção: controla o OBS (via servidor), as legendas, o roteiro e os celulares */
(function () {
  'use strict';
  const { Hub, $, $$, el, fmtBytes } = window.TI;

  // ------------------------------------------------------------ estado
  const S = {
    obs: false, scenes: [], program: '', transitions: [], transition: '',
    streaming: false, recording: false, lastStreamBytes: 0, lastStreamTs: 0,
    overlay: {}, roteiro: { itens: [], atual: -1 }, presets: { legendas: [], versiculos: [], avisos: [] },
    cams: [], config: null, info: null, editing: false, audioInputs: [],
    tally: {}, // nome da câmera -> true/false
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
      case 'obsStatus': S.obs = m.connected; refreshObsLocal(); setBadge($('#obsBadge'), m.connected ? 'ok' : 'danger', 'OBS'); $('#cfgObsMsg').textContent = m.connected ? 'Conectado ✔' : (m.error ? 'Erro: ' + m.error : 'Desconectado'); if (m.connected) refreshObs(); break;
      case 'obsEvent': onObsEvent(m.event, m.data); break;
      case 'overlay': S.overlay = m.overlay; renderOverlayState(); break;
      case 'roteiro': S.roteiro = m.roteiro; renderRoteiro(); break;
      case 'presets': S.presets = m.presets; renderPresets(); break;
      case 'cams': S.cams = m.cams; renderCams(); updateTally(); break;
      case 'camStats': { const c = S.cams.find((x) => x.id === m.id); if (c) { c.meta = Object.assign({}, c.meta, m.stats); renderCams(); } break; }
      case 'config': S.config = m.config; renderConfig(); break;
      default: break;
    }
  }

  async function loadInfo() {
    try { S.info = await (await fetch('/api/info')).json(); renderQr(); renderNet(); } catch { /* ignorar */ }
  }

  // ------------------------------------------------------------ OBS: cenas, programa, transição, status
  async function refreshObs() {
    try {
      const sl = await obs('GetSceneList');
      S.scenes = sl.scenes.sort((a, b) => b.sceneIndex - a.sceneIndex).map((s) => s.sceneName);
      S.program = sl.currentProgramSceneName;
      const tl = await obs('GetSceneTransitionList');
      S.transitions = tl.transitions.map((t) => t.transitionName); S.transition = tl.currentSceneTransitionName;
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
      case 'SceneListChanged': case 'SceneCreated': case 'SceneRemoved': case 'SceneNameChanged': refreshObs(); break;
      case 'CurrentSceneTransitionChanged': S.transition = d.transitionName; renderTransitions(); break;
      case 'StreamStateChanged': S.streaming = d.outputActive; renderStream(); break;
      case 'RecordStateChanged': S.recording = d.outputActive; renderRecord(); break;
      case 'InputMuteStateChanged': { const i = S.audioInputs.find((x) => x.name === d.inputName); if (i) { i.muted = d.inputMuted; renderAudio(); } break; }
      case 'InputVolumeChanged': { const i = S.audioInputs.find((x) => x.name === d.inputName); if (i) { i.db = d.inputVolumeDb; renderAudio(); } break; }
      case 'InputCreated': case 'InputRemoved': case 'InputNameChanged': refreshAudio(); break;
      default: break;
    }
  }

  function renderScenes() {
    const box = $('#scenes'); box.innerHTML = '';
    const visible = S.scenes.filter((n) => n !== 'Overlay' && !n.startsWith('_'));
    visible.forEach((name, i) => {
      const b = el('button', { class: name === S.program ? 'program' : '', onclick: () => setScene(name) }, [
        el('span', { text: name }),
        i < 9 ? el('span', { class: 'key', text: String(i + 1) }) : null,
        name === S.program ? el('span', { class: 'sub', text: 'NO AR' }) : null,
      ]);
      box.append(b);
    });
    if (!visible.length) box.append(el('p', { class: 'muted', text: S.obs ? 'Nenhuma cena no OBS.' : 'Conecte o OBS na aba Config.' }));
    $('#previewLabel').textContent = S.program || '';
  }
  async function setScene(name) {
    try { await obs('SetCurrentProgramScene', { sceneName: name }); } catch (e) { toast('Não foi possível trocar: ' + e.message, true); }
  }
  function renderTransitions() {
    const sel = $('#transition'); sel.innerHTML = '';
    for (const t of S.transitions) sel.append(el('option', { value: t, text: t, selected: t === S.transition }));
  }
  $('#transition').addEventListener('change', (e) => obs('SetCurrentSceneTransition', { transitionName: e.target.value }).catch(() => {}));

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    const visible = S.scenes.filter((n) => n !== 'Overlay' && !n.startsWith('_'));
    if (e.key >= '1' && e.key <= '9' && visible[Number(e.key) - 1]) setScene(visible[Number(e.key) - 1]);
    if (e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); nextItem(1); }
    if (e.key === 'PageUp') { e.preventDefault(); nextItem(-1); }
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
  function clearOverlay() { overlayPatch({ lowerThird: { visible: false }, verse: { visible: false }, ticker: { visible: false }, title: { visible: false }, countdown: { visible: false } }); }
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
  }

  // ------------------------------------------------------------ Roteiro
  function saveRoteiro() { fetch('/api/roteiro', { method: 'PUT', body: JSON.stringify(S.roteiro) }); }
  function renderRoteiro() {
    const ol = $('#roteiroList'); ol.innerHTML = ''; ol.classList.toggle('editing', S.editing);
    const { itens, atual } = S.roteiro;
    itens.forEach((it, i) => {
      const desc = [it.cena ? '🎬 ' + it.cena : null, acaoLabel(it.acao)].filter(Boolean).join('  ·  ');
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
    const map = { clear: '🧹 limpar legendas', lower: '🔤 ' + (a.title || ''), verse: '📖 ' + (a.ref || ''), title: '🏷️ ' + (a.text || ''), ticker: '📣 aviso', countdown: '⏱ contagem ' + (a.minutes || 0) + ' min' };
    return map[a.tipo] || a.tipo;
  }
  function move(i, d) { const it = S.roteiro.itens; const j = i + d; if (j < 0 || j >= it.length) return; [it[i], it[j]] = [it[j], it[i]]; if (S.roteiro.atual === i) S.roteiro.atual = j; else if (S.roteiro.atual === j) S.roteiro.atual = i; saveRoteiro(); }
  function nextItem(d) { const n = S.roteiro.atual + d; if (n < 0 || n >= S.roteiro.itens.length) return; goTo(n); }
  async function goTo(i) {
    const it = S.roteiro.itens[i]; if (!it) return;
    S.roteiro.atual = i; saveRoteiro(); renderRoteiro();
    if (it.cena) setScene(it.cena);
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
  }
  $('#riAdd').addEventListener('click', () => {
    const titulo = $('#riTitulo').value.trim(); if (!titulo) return toast('Dê um título ao item', true);
    const tipo = $('#riAcao').value;
    const v = (id) => ($('#' + id) ? $('#' + id).value : '');
    const acao = { tipo, title: v('riTitle'), subtitle: v('riSubtitle'), ref: v('riRef'), text: v('riText'), minutes: Number(v('riMinutes') || 0), message: v('riMessage') };
    S.roteiro.itens.push({ titulo, cena: $('#riCena').value, acao });
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
    $('#cfgPwdHint').textContent = c.obs.hasPassword ? '(já salva)' : '(nenhuma)';
    $('#cfgCams').value = (c.cameraNames || []).join('\n');
  }
  // ---- OBS instalado neste computador
  async function refreshObsLocal() {
    let st;
    try { st = await (await fetch('/api/obs/local')).json(); } catch { return; }
    const msg = $('#obsLocalMsg'), launch = $('#obsLaunch'), enable = $('#obsEnableWs');
    launch.hidden = true; enable.hidden = true;
    if (!st.installed) { msg.innerHTML = 'OBS Studio <b>não encontrado</b> neste computador. Instale em obsproject.com e reinicie este programa.'; return; }
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
  $('#cfgSaveCams').addEventListener('click', async () => {
    await fetch('/api/config', { method: 'PUT', body: JSON.stringify({ cameraNames: $('#cfgCams').value.split('\n').map((s) => s.trim()).filter(Boolean) }) });
    toast('Nomes salvos'); loadInfo();
  });

  // ------------------------------------------------------------ abas, badges, toast
  for (const b of $$('.tabs button')) b.addEventListener('click', () => {
    for (const x of $$('.tabs button')) x.classList.toggle('active', x === b);
    for (const t of $$('.tab')) t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab);
    if (b.dataset.tab === 'audio') refreshAudio();
  });
  function setBadge(elm, cls, label) { elm.className = 'badge ' + cls; elm.innerHTML = `<span class="dot ${cls}"></span>${label}`; }
  let toastTimer;
  function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 3500); }

  renderRiFields(); renderStream(); renderRecord();
})();
