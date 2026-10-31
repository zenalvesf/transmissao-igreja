/* Fonte de navegador do OBS: recebe o vídeo do celular via WebRTC.
 * URL: /view/<nome da câmera>?fit=cover|contain&audio=1&debug=1&nosignal=freeze|black|message
 */
(function () {
  'use strict';
  const { Hub, iceConfig, fmtBytes } = window.TI;
  const params = new URLSearchParams(location.search);
  const camName = decodeURIComponent(location.pathname.replace(/^\/view\/?/, '')) || params.get('cam') || 'Celular 1';
  const fit = params.get('fit') || 'cover';
  const audio = params.get('audio') === '1';
  const debug = params.get('debug') === '1';
  const nosignal = params.get('nosignal') || 'freeze';

  const video = document.getElementById('v');
  const dbg = document.getElementById('debug');
  const ns = document.getElementById('nosignal');
  document.body.classList.toggle('contain', fit === 'contain');
  document.body.classList.toggle('debug', debug);
  document.body.classList.toggle('transparent', nosignal === 'transparent');
  video.muted = !audio;
  if (audio) video.volume = 1;
  document.title = 'OBS – ' + camName;

  let pc = null, camId = null, lastBytes = 0, lastTs = 0, hubState = 'offline', pcState = '-';
  let candidateQueue = [];

  const hub = new Hub({ role: 'view', cam: camName }, onMessage, (st) => { hubState = st; render(); });

  function onMessage(m) {
    switch (m.type) {
      case 'camOnline': camId = m.camId; resetPeer(); break; // a câmera vai mandar uma oferta nova
      case 'camOffline': camId = null; closePeer(); showNoSignal(true); break;
      case 'signal': onSignal(m.from, m.data); break;
      default: break;
    }
    render();
  }

  function resetPeer() {
    closePeer();
    pc = new RTCPeerConnection(iceConfig(hub.stun));
    candidateQueue = [];
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      if (video.srcObject !== stream) { video.srcObject = stream; video.play().catch(() => {}); }
      showNoSignal(false);
    };
    pc.onicecandidate = (ev) => { if (ev.candidate && camId) hub.send({ type: 'signal', to: camId, data: { candidate: ev.candidate } }); };
    pc.onconnectionstatechange = () => {
      pcState = pc.connectionState;
      if (pcState === 'failed' || pcState === 'closed') showNoSignal(true);
      if (pcState === 'connected') showNoSignal(false);
      render();
    };
  }

  async function onSignal(from, data) {
    if (!pc || from !== camId) { camId = from; resetPeer(); }
    try {
      if (data.sdp && data.sdp.type === 'offer') {
        await pc.setRemoteDescription(data.sdp);
        for (const c of candidateQueue) await pc.addIceCandidate(c).catch(() => {});
        candidateQueue = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        hub.send({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else candidateQueue.push(data.candidate);
      }
    } catch (e) { console.warn('signal', e); }
  }

  function closePeer() {
    if (pc) { try { pc.close(); } catch { /* ignorar */ } }
    pc = null; pcState = '-';
  }

  function showNoSignal(on) {
    if (!on) { document.body.classList.remove('show-nosignal'); return; }
    if (nosignal === 'black') { video.srcObject = null; }
    else if (nosignal === 'message') { ns.textContent = camName + ' — sem sinal'; document.body.classList.add('show-nosignal'); }
    // 'freeze' (padrão): mantém o último quadro na tela
  }

  // Estatísticas para o modo debug
  setInterval(async () => {
    if (!debug || !pc || pc.connectionState !== 'connected') return render();
    try {
      const report = await pc.getStats();
      let bytes = 0, fps = 0, w = 0, h = 0, codec = '', codecs = {};
      report.forEach((r) => { if (r.type === 'codec') codecs[r.id] = r.mimeType; });
      report.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') { bytes = r.bytesReceived; fps = r.framesPerSecond || 0; w = r.frameWidth; h = r.frameHeight; codec = codecs[r.codecId] || ''; }
      });
      const now = Date.now();
      const bps = lastTs && bytes >= lastBytes ? (bytes - lastBytes) * 8 / ((now - lastTs) / 1000) : 0;
      lastBytes = bytes; lastTs = now;
      render(`${w}x${h} ${Math.round(fps)}fps ${fmtBytes(bps)} ${codec}`);
    } catch { render(); }
  }, 1000);

  function render(extra) {
    if (!debug) return;
    dbg.textContent = `${camName}\nservidor: ${hubState}\nwebrtc: ${pcState}\n${extra || ''}`;
  }
})();
