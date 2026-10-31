/* Celular como câmera: captura, publica via WebRTC para cada fonte do OBS e reconecta sozinho */
(function () {
  'use strict';
  const { Hub, $, el, fmtBytes, iceConfig } = window.TI;

  const params = new URLSearchParams(location.search);
  const TEST = params.get('test') === '1';
  const BITRATE = { 540: 2000000, 720: 3500000, 1080: 6000000 };

  const ui = {
    setup: $('#setup'), live: $('#live'), insecure: $('#insecure'),
    camName: $('#camName'), camNameCustom: $('#camNameCustom'), device: $('#device'),
    quality: $('#quality'), fps: $('#fps'), audio: $('#audio'), codec: $('#codec'), start: $('#start'),
    preview: $('#preview'), connDot: $('#connDot'), liveName: $('#liveName'), msg: $('#msg'),
    statViewers: $('#statViewers b'), statBitrate: $('#statBitrate b'), statRes: $('#statRes b'), statBattery: $('#statBattery'),
    zoomRow: $('#zoomRow'), zoom: $('#zoom'), zoomVal: $('#zoomVal'),
    expRow: $('#expRow'), exposure: $('#exposure'), expVal: $('#expVal'),
    btnZoom: $('#btnZoom'), btnExp: $('#btnExp'), btnTorch: $('#btnTorch'), btnFlip: $('#btnFlip'), btnMute: $('#btnMute'), btnStop: $('#btnStop'),
  };

  const state = {
    name: '', stream: null, track: null, audioTrack: null, hub: null,
    peers: new Map(), // viewerId -> { pc, disconnectTimer }
    facing: 'environment', deviceId: null, quality: 720, fps: 30, audio: false, codec: 'H264',
    torch: false, muted: false, wakeLock: null, lastBytes: 0, lastTs: 0, tally: false,
  };

  // ------------------------------------------------------------ setup
  if (!window.isSecureContext && !TEST) ui.insecure.style.display = 'block';

  const saved = JSON.parse(localStorage.getItem('cam.settings') || '{}');
  fetch('/api/info').then((r) => r.json()).then((info) => {
    ui.camName.innerHTML = '';
    for (const n of info.cameraNames || []) ui.camName.append(el('option', { value: n, text: n }));
    ui.camName.append(el('option', { value: '__custom', text: 'Outro nome…' }));
    if (saved.name) {
      if ([...ui.camName.options].some((o) => o.value === saved.name)) ui.camName.value = saved.name;
      else { ui.camName.value = '__custom'; ui.camNameCustom.value = saved.name; ui.camNameCustom.style.display = 'block'; }
    }
  }).catch(() => {});
  for (const k of ['quality', 'fps', 'audio', 'codec']) if (saved[k] != null) ui[k].value = String(saved[k]);
  ui.camName.addEventListener('change', () => { ui.camNameCustom.style.display = ui.camName.value === '__custom' ? 'block' : 'none'; });

  // Lista as câmeras físicas (precisa de permissão para mostrar os nomes; antes disso só traseira/frontal)
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then((devs) => {
      const cams = devs.filter((d) => d.kind === 'videoinput' && d.label);
      if (cams.length > 1) {
        for (const d of cams) ui.device.append(el('option', { value: 'id:' + d.deviceId, text: d.label }));
      }
    }).catch(() => {});
  }

  ui.start.addEventListener('click', start);

  async function start() {
    state.name = ui.camName.value === '__custom' ? ui.camNameCustom.value.trim() : ui.camName.value;
    if (!state.name) { alert('Dê um nome para a câmera.'); return; }
    state.quality = Number(ui.quality.value); state.fps = Number(ui.fps.value);
    state.audio = ui.audio.value === '1'; state.codec = ui.codec.value;
    const dev = ui.device.value;
    if (dev.startsWith('id:')) { state.deviceId = dev.slice(3); state.facing = null; } else { state.deviceId = null; state.facing = dev; }
    localStorage.setItem('cam.settings', JSON.stringify({ name: state.name, quality: state.quality, fps: state.fps, audio: state.audio ? 1 : 0, codec: state.codec }));

    ui.start.disabled = true; ui.start.textContent = 'Abrindo câmera…';
    try {
      await openCamera();
    } catch (e) {
      ui.start.disabled = false; ui.start.textContent = '▶ Iniciar câmera';
      alert('Não foi possível abrir a câmera: ' + (e.message || e) + '\n\nVerifique se o navegador tem permissão de câmera e se o endereço começa com https://');
      return;
    }
    ui.setup.style.display = 'none'; ui.live.classList.add('on');
    ui.liveName.textContent = state.name;
    requestWakeLock();
    connectHub();
    setInterval(collectStats, 2000);
    updateBattery();
  }

  // ------------------------------------------------------------ câmera
  function videoConstraints() {
    const h = state.quality, w = Math.round(h * 16 / 9);
    const c = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: state.fps, max: 60 } };
    if (state.deviceId) c.deviceId = { exact: state.deviceId }; else c.facingMode = { ideal: state.facing || 'environment' };
    return c;
  }

  async function openCamera() {
    if (state.stream) for (const t of state.stream.getTracks()) t.stop();
    let stream;
    if (TEST) {
      stream = testStream();
    } else {
      const audio = state.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } } : false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(), audio });
      } catch (e) {
        // Fallback: alguns aparelhos recusam a resolução pedida
        stream = await navigator.mediaDevices.getUserMedia({ video: state.deviceId ? { deviceId: { exact: state.deviceId } } : { facingMode: state.facing || 'environment' }, audio });
      }
    }
    state.stream = stream;
    state.track = stream.getVideoTracks()[0];
    state.audioTrack = stream.getAudioTracks()[0] || null;
    if (state.audioTrack) state.audioTrack.enabled = !state.muted;
    try { state.track.contentHint = 'motion'; } catch { /* ignorar */ }
    ui.preview.srcObject = stream;
    ui.preview.play().catch(() => {});
    state.track.addEventListener('ended', () => { showMsg('A câmera foi interrompida. Tentando reabrir…'); setTimeout(() => openCamera().then(replaceTracks).then(hideMsg).catch(() => {}), 1500); });
    setupCapabilities();
    ui.btnMute.style.display = state.audioTrack ? '' : 'none';
    return stream;
  }

  function setupCapabilities() {
    const caps = (state.track.getCapabilities && state.track.getCapabilities()) || {};
    const settings = (state.track.getSettings && state.track.getSettings()) || {};
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      ui.zoom.min = caps.zoom.min; ui.zoom.max = caps.zoom.max; ui.zoom.step = caps.zoom.step || 0.1;
      ui.zoom.value = settings.zoom || caps.zoom.min; ui.zoomVal.textContent = Number(ui.zoom.value).toFixed(1) + 'x';
      ui.btnZoom.disabled = false;
    } else { ui.btnZoom.disabled = true; ui.zoomRow.classList.remove('show'); }
    if (caps.exposureCompensation && caps.exposureCompensation.max > caps.exposureCompensation.min) {
      ui.exposure.min = caps.exposureCompensation.min; ui.exposure.max = caps.exposureCompensation.max; ui.exposure.step = caps.exposureCompensation.step || 1;
      ui.exposure.value = settings.exposureCompensation || 0; ui.expVal.textContent = ui.exposure.value;
      ui.btnExp.disabled = false;
    } else { ui.btnExp.disabled = true; ui.expRow.classList.remove('show'); }
    ui.btnTorch.disabled = !caps.torch;
    state.capabilities = { zoom: !!caps.zoom, exposure: !!caps.exposureCompensation, torch: !!caps.torch, facing: settings.facingMode || state.facing };
    sendStats();
  }

  async function applyAdvanced(obj) {
    try { await state.track.applyConstraints({ advanced: [obj] }); } catch (e) { console.warn('applyConstraints', e); }
  }
  function setZoom(v) { v = Number(v); ui.zoom.value = v; ui.zoomVal.textContent = v.toFixed(1) + 'x'; applyAdvanced({ zoom: v }); }
  function setExposure(v) { v = Number(v); ui.exposure.value = v; ui.expVal.textContent = v; applyAdvanced({ exposureCompensation: v }); }
  function setTorch(on) { state.torch = !!on; ui.btnTorch.classList.toggle('active', state.torch); applyAdvanced({ torch: state.torch }); }
  function setMute(on) { state.muted = !!on; if (state.audioTrack) state.audioTrack.enabled = !state.muted; ui.btnMute.classList.toggle('active', state.muted); ui.btnMute.textContent = state.muted ? '🔇 Mudo' : '🎤 Áudio'; }
  async function flip() {
    state.deviceId = null; state.facing = state.facing === 'user' ? 'environment' : 'user';
    try { await openCamera(); await replaceTracks(); } catch (e) { showMsg('Não deu para trocar a câmera: ' + e.message); setTimeout(hideMsg, 2500); }
  }
  async function setQuality(q) {
    state.quality = Number(q);
    try { await state.track.applyConstraints(videoConstraints()); } catch { await openCamera(); await replaceTracks(); }
    for (const { pc } of state.peers.values()) tuneSenders(pc);
  }
  async function replaceTracks() {
    for (const { pc } of state.peers.values()) {
      for (const s of pc.getSenders()) {
        if (s.track && s.track.kind === 'video') await s.replaceTrack(state.track);
        if (s.track && s.track.kind === 'audio' && state.audioTrack) await s.replaceTrack(state.audioTrack);
      }
    }
  }

  ui.btnZoom.addEventListener('click', () => { ui.zoomRow.classList.toggle('show'); ui.expRow.classList.remove('show'); });
  ui.btnExp.addEventListener('click', () => { ui.expRow.classList.toggle('show'); ui.zoomRow.classList.remove('show'); });
  ui.zoom.addEventListener('input', () => setZoom(ui.zoom.value));
  ui.exposure.addEventListener('input', () => setExposure(ui.exposure.value));
  ui.btnTorch.addEventListener('click', () => setTorch(!state.torch));
  ui.btnFlip.addEventListener('click', flip);
  ui.btnMute.addEventListener('click', () => setMute(!state.muted));
  ui.btnStop.addEventListener('click', () => { if (confirm('Parar a câmera?')) location.reload(); });

  // ------------------------------------------------------------ sinalização
  function connectHub() {
    state.hub = new Hub({ role: 'cam', name: state.name, meta: { ua: navigator.userAgent } }, onHubMessage, (st) => {
      ui.connDot.className = 'dot ' + (st === 'online' ? 'ok' : st === 'connecting' ? 'warn pulse' : 'danger pulse');
      if (st !== 'online') showMsg('Reconectando ao servidor…'); else hideMsg();
    });
  }

  function onHubMessage(m) {
    switch (m.type) {
      case 'welcome':
        // Após (re)conectar, o servidor reenvia viewerJoined para cada fonte do OBS. Começamos do zero.
        for (const id of [...state.peers.keys()]) closePeer(id);
        sendStats();
        break;
      case 'viewerJoined': createPeer(m.viewerId); break;
      case 'viewerLeft': closePeer(m.viewerId); break;
      case 'signal': onSignal(m.from, m.data); break;
      case 'replaced':
        showMsg('Outro celular entrou com o nome "' + state.name + '". Esta câmera foi desligada.');
        for (const id of [...state.peers.keys()]) closePeer(id);
        state.hub.close();
        break;
      case 'control': onControl(m.cmd, m.value); break;
      default: break;
    }
    ui.statViewers.textContent = String(state.peers.size);
  }

  function onControl(cmd, value) {
    if (cmd === 'zoom') setZoom(value);
    else if (cmd === 'exposure') setExposure(value);
    else if (cmd === 'torch') setTorch(value);
    else if (cmd === 'mute') setMute(value);
    else if (cmd === 'flip') flip();
    else if (cmd === 'quality') setQuality(value);
    else if (cmd === 'tally') { state.tally = !!value; ui.live.classList.toggle('tally', state.tally); }
    else if (cmd === 'restart') { openCamera().then(replaceTracks).catch(() => {}); }
    else if (cmd === 'reload') location.reload();
  }

  // ------------------------------------------------------------ WebRTC
  function preferCodec(pc) {
    if (!('setCodecPreferences' in RTCRtpTransceiver.prototype) || !RTCRtpSender.getCapabilities) return;
    const caps = RTCRtpSender.getCapabilities('video');
    if (!caps) return;
    const want = state.codec.toLowerCase();
    const order = ['video/' + want, 'video/vp8', 'video/h264', 'video/vp9', 'video/av1'];
    const sorted = [...caps.codecs].sort((a, b) => {
      const ia = order.indexOf(a.mimeType.toLowerCase()), ib = order.indexOf(b.mimeType.toLowerCase());
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    for (const t of pc.getTransceivers()) {
      if (t.sender.track && t.sender.track.kind === 'video') { try { t.setCodecPreferences(sorted); } catch { /* ignorar */ } }
    }
  }

  function tuneSenders(pc) {
    for (const s of pc.getSenders()) {
      if (!s.track || s.track.kind !== 'video') continue;
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = BITRATE[state.quality] || 3500000;
      p.encodings[0].maxFramerate = state.fps;
      p.degradationPreference = 'maintain-resolution';
      s.setParameters(p).catch(() => {});
    }
  }

  async function createPeer(viewerId) {
    closePeer(viewerId);
    const pc = new RTCPeerConnection(iceConfig(state.hub.stun));
    const entry = { pc, disconnectTimer: null };
    state.peers.set(viewerId, entry);
    pc.addTrack(state.track, state.stream);
    if (state.audioTrack) pc.addTrack(state.audioTrack, state.stream);
    preferCodec(pc);
    tuneSenders(pc);
    pc.onicecandidate = (ev) => { if (ev.candidate) state.hub.send({ type: 'signal', to: viewerId, data: { candidate: ev.candidate } }); };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') { clearTimeout(entry.disconnectTimer); hideMsg(); }
      if (st === 'failed') { renegotiate(viewerId, true); }
      if (st === 'disconnected') {
        clearTimeout(entry.disconnectTimer);
        entry.disconnectTimer = setTimeout(() => { if (pc.connectionState === 'disconnected') renegotiate(viewerId, true); }, 4000);
      }
      ui.statViewers.textContent = String([...state.peers.values()].filter((e) => e.pc.connectionState === 'connected').length);
    };
    pc.onnegotiationneeded = () => renegotiate(viewerId, false);
    ui.statViewers.textContent = String(state.peers.size);
  }

  async function renegotiate(viewerId, iceRestart) {
    const entry = state.peers.get(viewerId);
    if (!entry) return;
    const { pc } = entry;
    if (pc.signalingState === 'closed') return;
    try {
      const offer = await pc.createOffer({ iceRestart: !!iceRestart });
      await pc.setLocalDescription(offer);
      state.hub.send({ type: 'signal', to: viewerId, data: { sdp: pc.localDescription } });
    } catch (e) { console.warn('offer', e); }
  }

  async function onSignal(from, data) {
    const entry = state.peers.get(from);
    if (!entry) return;
    const { pc } = entry;
    try {
      if (data.sdp) {
        if (data.sdp.type === 'answer') await pc.setRemoteDescription(data.sdp);
      } else if (data.candidate) {
        await pc.addIceCandidate(data.candidate);
      }
    } catch (e) { console.warn('signal', e); }
  }

  function closePeer(viewerId) {
    const entry = state.peers.get(viewerId);
    if (!entry) return;
    clearTimeout(entry.disconnectTimer);
    try { entry.pc.close(); } catch { /* ignorar */ }
    state.peers.delete(viewerId);
  }

  // ------------------------------------------------------------ estatísticas, bateria, tela ligada
  async function collectStats() {
    let bytes = 0, fps = 0, w = 0, h = 0, codec = '';
    for (const { pc } of state.peers.values()) {
      if (pc.connectionState !== 'connected') continue;
      try {
        const report = await pc.getStats();
        const codecs = {};
        report.forEach((r) => { if (r.type === 'codec') codecs[r.id] = r.mimeType; });
        report.forEach((r) => {
          if (r.type === 'outbound-rtp' && r.kind === 'video') {
            bytes += r.bytesSent || 0; fps = r.framesPerSecond || fps; w = r.frameWidth || w; h = r.frameHeight || h;
            if (r.codecId && codecs[r.codecId]) codec = codecs[r.codecId].replace('video/', '');
          }
        });
      } catch { /* ignorar */ }
    }
    const now = Date.now();
    const bps = state.lastTs ? Math.max(0, (bytes - state.lastBytes) * 8 / ((now - state.lastTs) / 1000)) : 0;
    state.lastBytes = bytes; state.lastTs = now;
    ui.statBitrate.textContent = state.peers.size ? fmtBytes(bps) : '–';
    ui.statRes.textContent = w ? `${w}×${h} ${Math.round(fps)}fps` : '–';
    state.stats = { bitrate: Math.round(bps), fps: Math.round(fps), width: w, height: h, codec, peers: state.peers.size };
    sendStats();
  }
  function sendStats() {
    if (!state.hub) return;
    const settings = (state.track && state.track.getSettings && state.track.getSettings()) || {};
    state.hub.send({ type: 'camStats', stats: Object.assign({}, state.stats || {}, {
      battery: state.battery, charging: state.charging, quality: state.quality, fpsTarget: state.fps, codecTarget: state.codec,
      capWidth: settings.width, capHeight: settings.height, facing: settings.facingMode || state.facing,
      capabilities: state.capabilities, zoom: Number(ui.zoom.value), torch: state.torch, muted: state.muted, hasAudio: !!state.audioTrack,
      tally: state.tally,
    }) });
  }
  async function updateBattery() {
    if (!navigator.getBattery) return;
    try {
      const b = await navigator.getBattery();
      const upd = () => { state.battery = Math.round(b.level * 100); state.charging = b.charging; ui.statBattery.textContent = (b.charging ? '⚡' : '🔋') + state.battery + '%'; };
      upd(); b.addEventListener('levelchange', upd); b.addEventListener('chargingchange', upd);
    } catch { /* ignorar */ }
  }
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignorar */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      // iOS pausa a câmera em segundo plano; ao voltar, reabre se preciso
      if (state.track && state.track.readyState === 'ended') openCamera().then(replaceTracks).catch(() => {});
    }
  });

  function showMsg(t) { ui.msg.textContent = t; ui.msg.classList.add('show'); }
  function hideMsg() { ui.msg.classList.remove('show'); }

  // ------------------------------------------------------------ modo teste (sem câmera): relógio animado
  function testStream() {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    const ctx = c.getContext('2d');
    let a = 0;
    const stream = c.captureStream(0);
    const track = stream.getVideoTracks()[0];
    setInterval(() => { // setInterval (e não requestAnimationFrame) para continuar desenhando em segundo plano
      ctx.fillStyle = '#123'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#4f8cff'; ctx.beginPath(); ctx.arc(640 + Math.cos(a) * 300, 360 + Math.sin(a) * 200, 60, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 64px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(state.name || 'teste', 640, 360); ctx.font = '40px monospace'; ctx.fillText(new Date().toLocaleTimeString(), 640, 440);
      a += 0.03;
      if (track.requestFrame) track.requestFrame();
    }, 33);
    return stream;
  }
})();
