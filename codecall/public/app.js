(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    lobby: $('lobby'), form: $('joinForm'), name: $('name'), code: $('code'), newCode: $('newCode'),
    startCam: $('startCam'), startMic: $('startMic'), error: $('lobbyError'), joinBtn: $('joinBtn'),
    call: $('call'), roomLabel: $('roomLabel'), copyLink: $('copyLink'), copyLabel: $('copyLabel'),
    count: $('count'), timer: $('timer'), grid: $('grid'),
    chat: $('chat'), chatClose: $('chatClose'), messages: $('messages'), chatForm: $('chatForm'), chatInput: $('chatInput'),
    micBtn: $('micBtn'), camBtn: $('camBtn'), shareBtn: $('shareBtn'), chatBtn: $('chatBtn'), badge: $('badge'), leaveBtn: $('leaveBtn'),
    toast: $('toast'), lost: $('lost'), rejoin: $('rejoinBtn'),
  };

  /* ---------- Room codes ---------- */
  const WORDS_A = ['maple', 'quiet', 'amber', 'brisk', 'coral', 'dusty', 'eager', 'fuzzy', 'gentle', 'hazel', 'ivory', 'jolly', 'keen', 'lunar', 'mellow', 'noble'];
  const WORDS_B = ['river', 'harbor', 'meadow', 'lantern', 'orchard', 'summit', 'canyon', 'willow', 'pebble', 'comet', 'garden', 'island', 'valley', 'thistle', 'breeze', 'anchor'];
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

  const rand = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  function makeCode() {
    let tail = '';
    for (let i = 0; i < 4; i++) tail += ALPHABET[rand(ALPHABET.length)];
    return `${WORDS_A[rand(WORDS_A.length)]}-${WORDS_B[rand(WORDS_B.length)]}-${tail}`;
  }
  const cleanCode = (v) =>
    v.toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  /* ---------- State ---------- */
  const media = { cam: null, mic: null, screen: null };
  const peers = new Map();
  let ws = null;
  let myId = null;
  let myName = 'Guest';
  let room = '';
  let joined = false;
  let leaving = false;
  let self = null;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let unread = 0;
  let timerStart = 0;
  let timerHandle = null;

  /* ---------- Helpers ---------- */
  let toastHandle = null;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastHandle);
    toastHandle = setTimeout(() => { el.toast.hidden = true; }, 4500);
  }

  function showError(text) {
    el.error.textContent = text;
    el.error.hidden = !text;
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  const getState = () => ({
    cam: !!media.cam,
    mic: !!media.mic && media.mic.enabled,
    screen: !!media.screen,
  });

  const videoOut = () => media.screen || media.cam || null;

  /* ---------- Media ---------- */
  async function gum(constraints) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('unsupported');
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  async function startMic() {
    const s = await gum({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const track = s.getAudioTracks()[0];
    track.onended = () => { if (media.mic === track) { media.mic = null; afterMediaChange(); } };
    media.mic = track;
  }

  async function startCam() {
    const s = await gum({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } });
    const track = s.getVideoTracks()[0];
    track.onended = () => { if (media.cam === track) { media.cam = null; afterMediaChange(); } };
    media.cam = track;
  }

  async function acquire(wantCam, wantMic) {
    const problems = [];
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (wantCam || wantMic) problems.push('Camera and microphone need a secure (https) page, so you joined without them.');
      return problems;
    }
    if (wantMic) {
      try { await startMic(); } catch { problems.push('Microphone is blocked or unavailable.'); }
    }
    if (wantCam) {
      try { await startCam(); } catch { problems.push('Camera is blocked or unavailable.'); }
    }
    return problems;
  }

  function stopAllMedia() {
    for (const key of ['cam', 'mic', 'screen']) {
      const t = media[key];
      if (t) { t.onended = null; t.stop(); media[key] = null; }
    }
  }

  async function toggleMic() {
    if (!media.mic) {
      try { await startMic(); } catch { toast('Microphone is blocked or unavailable. Check your browser permissions.'); return; }
    } else {
      media.mic.enabled = !media.mic.enabled;
    }
    afterMediaChange();
  }

  async function toggleCam() {
    if (media.cam) {
      media.cam.onended = null;
      media.cam.stop();
      media.cam = null;
    } else {
      try { await startCam(); } catch { toast('Camera is blocked or unavailable. Check your browser permissions.'); return; }
    }
    afterMediaChange();
  }

  async function toggleScreen() {
    if (media.screen) { stopScreen(); return; }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
      const track = s.getVideoTracks()[0];
      if ('contentHint' in track) track.contentHint = 'detail';
      track.onended = stopScreen;
      media.screen = track;
      afterMediaChange();
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') toast('Could not start screen sharing.');
    }
  }

  function stopScreen() {
    if (!media.screen) return;
    media.screen.onended = null;
    media.screen.stop();
    media.screen = null;
    afterMediaChange();
  }

  function applyTracks(p) {
    if (p.aSender) p.aSender.replaceTrack(media.mic || null).catch(() => {});
    if (p.vSender) p.vSender.replaceTrack(videoOut()).catch(() => {});
  }

  function syncButtons() {
    const st = getState();
    el.micBtn.dataset.off = String(!st.mic);
    el.micBtn.setAttribute('aria-pressed', String(st.mic));
    el.micBtn.setAttribute('aria-label', st.mic ? 'Mute microphone' : 'Unmute microphone');
    el.camBtn.dataset.off = String(!st.cam);
    el.camBtn.setAttribute('aria-pressed', String(st.cam));
    el.camBtn.setAttribute('aria-label', st.cam ? 'Turn camera off' : 'Turn camera on');
    el.shareBtn.setAttribute('aria-pressed', String(st.screen));
    el.shareBtn.setAttribute('aria-label', st.screen ? 'Stop sharing your screen' : 'Share your screen');
  }

  function afterMediaChange() {
    syncButtons();
    if (!joined) return;
    for (const p of peers.values()) applyTracks(p);
    const out = videoOut();
    self.video.srcObject = out ? new MediaStream([out]) : null;
    self.state = getState();
    renderTile(self);
    updateLayout();
    send({ type: 'state', state: self.state });
  }

  /* ---------- Tiles ---------- */
  const MIC_OFF_SVG =
    '<svg class="ico mic-off" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3"/><path d="M19 11a7 7 0 0 1-1.1 3.8M5 11a7 7 0 0 0 11 5.7M12 18v3"/></svg>';

  function makeTile(id, name, isSelf) {
    const tile = document.createElement('div');
    tile.className = 'tile no-video';
    tile.dataset.id = id;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (isSelf) video.muted = true;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    const initial = document.createElement('span');
    avatar.append(initial);

    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = 'Connecting…';

    const label = document.createElement('div');
    label.className = 'label';
    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    label.append(nameEl);
    const micWrap = document.createElement('span');
    micWrap.innerHTML = MIC_OFF_SVG;
    label.append(micWrap);

    tile.append(video, avatar, status, label);
    const entry = { id, name, isSelf, tile, video, initial, nameEl, micWrap, state: {} };
    return entry;
  }

  function renderTile(t) {
    const showVideo = !!(t.state.cam || t.state.screen);
    t.tile.classList.toggle('no-video', !showVideo);
    t.tile.classList.toggle('is-screen', !!t.state.screen);
    t.tile.classList.toggle('mirror', t.isSelf && !t.state.screen);
    t.nameEl.textContent = t.isSelf ? `${t.name} (you)` : t.name;
    t.initial.textContent = (t.name.trim()[0] || '?').toUpperCase();
    t.micWrap.hidden = !!t.state.mic;
  }

  function updateLayout() {
    const tiles = [...el.grid.children];
    const n = tiles.length;
    el.grid.dataset.count = String(Math.min(n, 8));
    const spot = tiles.find((t) => t.classList.contains('is-screen')) || null;
    el.grid.classList.toggle('has-spotlight', !!spot);
    el.grid.style.setProperty('--others', String(Math.max(1, n - 1)));
    for (const t of tiles) t.classList.toggle('spotlight', t === spot);
    el.count.textContent = `${n} in call`;
  }

  /* ---------- Peers ---------- */
  function addPeer(info, initiator) {
    if (peers.has(info.id)) return;
    const t = makeTile(info.id, info.name || 'Guest', false);
    const p = Object.assign(t, {
      initiator,
      pc: null,
      stream: new MediaStream(),
      pending: [],
      queue: Promise.resolve(),
      aSender: null,
      vSender: null,
    });
    p.state = info.state || {};
    p.video.srcObject = p.stream;
    p.tile.classList.add('connecting');
    peers.set(p.id, p);
    el.grid.append(p.tile);
    renderTile(p);
    updateLayout();
    if (initiator) {
      createPc(p);
      negotiate(p, false);
    }
  }

  function removePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.pc && p.pc.close(); } catch { /* ignore */ }
    p.tile.remove();
    peers.delete(id);
    updateLayout();
  }

  function createPc(p) {
    const pc = new RTCPeerConnection({ iceServers });
    p.pc = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'signal', to: p.id, data: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      p.stream.addTrack(e.track);
      p.video.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      p.tile.classList.toggle('connecting', s !== 'connected');
      if (s === 'failed' && p.initiator) negotiate(p, true);
    };
  }

  async function negotiate(p, iceRestart) {
    const pc = p.pc;
    try {
      if (!p.aSender) {
        p.aSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
        p.vSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
        applyTracks(p);
      }
      const offer = await pc.createOffer({ iceRestart });
      await pc.setLocalDescription(offer);
      send({ type: 'signal', to: p.id, data: { description: pc.localDescription } });
    } catch (err) {
      console.warn('negotiate failed', err);
    }
  }

  async function handleSignal(p, data) {
    if (data.description) {
      if (!p.pc) createPc(p);
      const pc = p.pc;
      await pc.setRemoteDescription(data.description);
      for (const c of p.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (data.description.type === 'offer') {
        for (const t of pc.getTransceivers()) {
          t.direction = 'sendrecv';
          if (t.receiver.track.kind === 'audio') p.aSender = t.sender;
          else p.vSender = t.sender;
        }
        applyTracks(p);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'signal', to: p.id, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      if (p.pc && p.pc.remoteDescription) await p.pc.addIceCandidate(data.candidate).catch(() => {});
      else p.pending.push(data.candidate);
    }
  }

  function onSignal(from, data) {
    const p = peers.get(from);
    if (!p || !data) return;
    // Handle one signal at a time per peer so offers, answers and candidates never overlap.
    p.queue = p.queue.then(() => handleSignal(p, data)).catch((err) => console.warn('signal failed', err));
  }

  /* ---------- Chat ---------- */
  const timeFmt = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function pushMessage(li) {
    const list = el.messages;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.append(li);
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  function addSystem(text) {
    const li = document.createElement('li');
    li.className = 'sys';
    li.textContent = text;
    pushMessage(li);
  }

  function addMessage(m) {
    const mine = m.from === myId;
    const li = document.createElement('li');
    li.className = 'msg' + (mine ? ' mine' : '');
    const head = document.createElement('div');
    head.className = 'msg-head';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = mine ? 'You' : m.name;
    const time = document.createElement('time');
    time.textContent = timeFmt(m.ts);
    head.append(who, time);
    const text = document.createElement('p');
    text.textContent = m.text;
    li.append(head, text);
    pushMessage(li);
    if (el.chat.hidden && !mine) {
      unread += 1;
      el.badge.textContent = unread > 9 ? '9+' : String(unread);
      el.badge.hidden = false;
    }
  }

  function setChatOpen(open) {
    el.chat.hidden = !open;
    el.chatBtn.setAttribute('aria-expanded', String(open));
    el.chatBtn.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    if (open) {
      unread = 0;
      el.badge.hidden = true;
      el.messages.scrollTop = el.messages.scrollHeight;
      el.chatInput.focus();
    }
  }

  /* ---------- Connection ---------- */
  async function loadConfig() {
    try {
      const res = await fetch('/config', { cache: 'no-store' });
      const cfg = await res.json();
      if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) iceServers = cfg.iceServers;
    } catch { /* keep defaults */ }
  }

  function connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      let settled = false;

      ws.onopen = () => send({ type: 'join', room, name: myName });

      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        switch (m.type) {
          case 'joined':
            onJoined(m);
            settled = true;
            resolve();
            break;
          case 'error':
            if (!settled) { settled = true; reject(new Error(m.message || 'Could not join this room.')); }
            break;
          case 'peer-joined':
            addPeer(m.peer, false);
            addSystem(`${m.peer.name} joined`);
            break;
          case 'peer-left': {
            const p = peers.get(m.id);
            if (p) addSystem(`${p.name} left`);
            removePeer(m.id);
            break;
          }
          case 'signal':
            onSignal(m.from, m.data);
            break;
          case 'state': {
            const p = peers.get(m.id);
            if (p) { p.state = m.state || {}; renderTile(p); updateLayout(); }
            break;
          }
          case 'chat':
            addMessage(m);
            break;
          default:
            break;
        }
      };

      ws.onclose = () => {
        if (!settled) { settled = true; reject(new Error('Could not reach the server. Check your connection and try again.')); return; }
        if (!leaving) el.lost.hidden = false;
      };
    });
  }

  function onJoined(m) {
    myId = m.id;
    joined = true;
    el.lobby.hidden = true;
    el.call.hidden = false;
    el.roomLabel.textContent = room;

    self = makeTile('self', myName, true);
    el.grid.append(self.tile);
    self.state = getState();
    renderTile(self);
    const out = videoOut();
    if (out) self.video.srcObject = new MediaStream([out]);

    for (const info of m.peers) addPeer(info, true);
    updateLayout();
    syncButtons();
    send({ type: 'state', state: getState() });

    el.shareBtn.hidden = !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    timerStart = Date.now();
    timerHandle = setInterval(() => {
      const s = Math.floor((Date.now() - timerStart) / 1000);
      const h = Math.floor(s / 3600);
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      el.timer.textContent = h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }, 1000);
  }

  function leaveCall() {
    leaving = true;
    clearInterval(timerHandle);
    try { ws && ws.close(); } catch { /* ignore */ }
    for (const p of peers.values()) { try { p.pc && p.pc.close(); } catch { /* ignore */ } }
    stopAllMedia();
    location.href = location.pathname;
  }

  /* ---------- Wiring ---------- */
  el.name.value = store.get('codecall-name');
  const urlRoom = cleanCode(new URLSearchParams(location.search).get('room') || '');
  el.code.value = urlRoom || '';
  if (urlRoom) el.name.focus();

  if (!window.isSecureContext) {
    showError('This page is not secure (no https), so your browser will block the camera and microphone. You can still join and chat.');
  }

  el.newCode.addEventListener('click', () => { el.code.value = makeCode(); el.code.focus(); });

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    myName = el.name.value.trim().slice(0, 30) || 'Guest';
    room = cleanCode(el.code.value);
    if (room.length < 3) { showError('Enter a room code with at least 3 letters or numbers.'); return; }
    el.code.value = room;
    store.set('codecall-name', el.name.value.trim());
    showError('');
    el.joinBtn.disabled = true;
    el.joinBtn.textContent = 'Joining…';
    let problems = [];
    try {
      await loadConfig();
      problems = await acquire(el.startCam.checked, el.startMic.checked);
      await connect();
    } catch (err) {
      stopAllMedia();
      try { ws && ws.close(); } catch { /* ignore */ }
      el.joinBtn.disabled = false;
      el.joinBtn.textContent = 'Join call';
      showError(err.message || 'Could not join this room.');
      return;
    }
    if (problems.length) toast(problems.join(' '));
  });

  el.copyLink.addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
    try {
      await navigator.clipboard.writeText(link);
      el.copyLabel.textContent = 'Link copied';
    } catch {
      el.copyLabel.textContent = link;
    }
    setTimeout(() => { el.copyLabel.textContent = 'Copy invite link'; }, 2500);
  });

  el.micBtn.addEventListener('click', toggleMic);
  el.camBtn.addEventListener('click', toggleCam);
  el.shareBtn.addEventListener('click', toggleScreen);
  el.chatBtn.addEventListener('click', () => setChatOpen(el.chat.hidden));
  el.chatClose.addEventListener('click', () => setChatOpen(false));
  el.leaveBtn.addEventListener('click', leaveCall);
  el.rejoin.addEventListener('click', () => { leaving = true; location.href = `${location.pathname}?room=${encodeURIComponent(room)}`; });

  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    el.chatInput.value = '';
  });

  document.addEventListener('keydown', (e) => {
    if (!joined || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (k === 'm') toggleMic();
    else if (k === 'v') toggleCam();
    else if (k === 'c') setChatOpen(el.chat.hidden);
  });

  window.addEventListener('beforeunload', () => { leaving = true; try { ws && ws.close(); } catch { /* ignore */ } });

  syncButtons();
})();
