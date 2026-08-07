'use strict';

const el = (id) => document.getElementById(id);
const socket = io();

function emitAck(event, payload, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, error: 'Zeitüberschreitung – der Server antwortet nicht. Bitte Internetverbindung prüfen und Seite neu laden.' });
    }, timeoutMs);
    socket.emit(event, payload, (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(res || { ok: false, error: 'Keine Antwort vom Server.' });
    });
  });
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
function range(min, max) { return Array.from({ length: max - min + 1 }, (_, i) => min + i); }

const state = {
  code: null,
  playerId: null,
  isHost: false,
  micStream: null,
  audioCtx: null,
  analyser: null,
  currentClip: null,
  cuts: [],
  pendingCutTime: 0,
  skipsUsed: 0,
  skipsAllowed: 0,
  deadline: null,
  timerInterval: null,
  mediaRecorder: null,
  ytDub: null,
  ytVote: null,
  pendingAfterMic: null,
  voteTarget: null,
  votedThisTarget: false,
};

const screens = [...document.querySelectorAll('.screen')];
function showScreen(id) {
  screens.forEach((s) => s.classList.toggle('hidden', s.id !== id));
}

el('btnCreate').addEventListener('click', () => {
  const name = el('createName').value.trim() || 'Host';
  runWithConnectingFeedback(el('btnCreate'), async () => {
    const res = await emitAck('lobby:create', { name });
    if (!res.ok) return showStartError(res.error);
    applyJoinResult(res);
  });
});

el('btnJoin').addEventListener('click', () => {
  const code = el('joinCode').value.trim().toUpperCase();
  const name = el('joinName').value.trim() || 'Spieler';
  if (!code) return showStartError('Bitte Lobby-Code eingeben.');
  runWithConnectingFeedback(el('btnJoin'), async () => {
    const res = await emitAck('lobby:join', { code, name });
    if (!res.ok) return showStartError(res.error);
    applyJoinResult(res);
  });
});

async function runWithConnectingFeedback(button, fn) {
  button.disabled = true;
  el('startStatus').classList.add('hidden');
  const slowTimer = setTimeout(() => {
    showStartStatus('Server braucht einen Moment – der kostenlose Tarif muss nach Inaktivität erst aufwachen (bis zu ca. 60 Sekunden). Bitte kurz warten …');
  }, 3000);
  try {
    await fn();
  } catch (err) {
    showStartError('Verbindung fehlgeschlagen. Bitte Seite neu laden und erneut versuchen.');
  } finally {
    clearTimeout(slowTimer);
    button.disabled = false;
    el('startStatus').classList.add('hidden');
  }
}

function showStartStatus(msg) {
  const e = el('startStatus');
  e.textContent = msg;
  e.classList.remove('hidden');
}

function showStartError(msg) {
  el('startStatus').classList.add('hidden');
  const e = el('startError');
  e.textContent = msg;
  e.classList.remove('hidden');
}

function applyJoinResult(res) {
  state.code = res.code;
  state.playerId = res.playerId;
  state.isHost = res.isHost;
  el('codeBadge').textContent = res.code;
  el('codeBadge').classList.remove('hidden');
  showScreen('screen-lobby');
  loadPacksIntoSelect();
  if (lastLobbyStatePayload && lastLobbyStatePayload.state === 'LOBBY') {
    renderLobby(lastLobbyStatePayload);
  }
}

let lastLobbyStatePayload = null;
socket.on('lobby:state', (payload) => {
  lastLobbyStatePayload = payload;
  if (state.playerId) {
    state.isHost = payload.hostId === state.playerId;
  }
  if (payload.round > 0) {
    el('roundBadge').textContent = `Runde ${payload.round}/${payload.config.maxRounds}`;
    el('roundBadge').classList.remove('hidden');
  }
  if (payload.state === 'LOBBY' && state.playerId) renderLobby(payload);
});

function ensureConfigSelectsPopulated(limits) {
  if (el('cfgMinutes').options.length) return;
  fillSelect('cfgMinutes', range(limits.minutesPerClip.min, limits.minutesPerClip.max), (v) => `${v} Minute${v > 1 ? 'n' : ''}`);
  fillSelect('cfgRounds', range(limits.maxRounds.min, limits.maxRounds.max), (v) => `${v} Runde${v > 1 ? 'n' : ''}`);
  fillSelect('cfgSkips', range(limits.skipsAllowed.min, limits.skipsAllowed.max), (v) => (v === 0 ? 'Keine' : `${v}`));
}
function fillSelect(id, values, labelFn) {
  const sel = el(id);
  sel.innerHTML = '';
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = String(v);
    opt.textContent = labelFn(v);
    sel.appendChild(opt);
  }
}

function renderLobby(payload) {
  el('lobbyCodeDisplay').textContent = payload.code;
  ensureConfigSelectsPopulated(payload.limits);
  el('cfgMinutes').value = String(payload.config.minutesPerClip);
  el('cfgRounds').value = String(payload.config.maxRounds);
  el('cfgSkips').value = String(payload.config.skipsAllowed);

  const amHost = state.isHost;
  ['cfgMinutes', 'cfgRounds', 'cfgSkips', 'cfgPack'].forEach((id) => { el(id).disabled = !amHost; });
  el('btnStart').classList.toggle('hidden', !amHost);
  el('waitingForHost').classList.toggle('hidden', amHost);

  const list = el('playerList');
  list.innerHTML = '';
  for (const p of payload.players) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(p.name)}</span>` +
      `<span>${p.isHost ? '<span class="host-tag">HOST</span> ' : ''}${!p.connected ? '<span class="offline">offline</span>' : ''}</span>`;
    list.appendChild(li);
  }
}

async function loadPacksIntoSelect() {
  const packs = await emitAck('packs:list', {});
  const sel = el('cfgPack');
  sel.innerHTML = '';
  for (const p of packs) {
    const opt = document.createElement('option');
    opt.value = p.packId;
    opt.textContent = `${p.packName} · ${p.clipCount} Clips`;
    sel.appendChild(opt);
  }
}

['cfgMinutes', 'cfgRounds', 'cfgSkips'].forEach((id) => {
  el(id).addEventListener('change', () => {
    emitAck('lobby:updateConfig', {
      minutesPerClip: Number(el('cfgMinutes').value),
      maxRounds: Number(el('cfgRounds').value),
      skipsAllowed: Number(el('cfgSkips').value),
    });
  });
});

el('btnStart').addEventListener('click', async () => {
  el('btnStart').disabled = true;
  const res = await emitAck('lobby:start', { packId: el('cfgPack').value });
  if (!res.ok) {
    el('btnStart').disabled = false;
    alert(res.error);
    return;
  }
  setTimeout(() => {
    if (!el('screen-lobby').classList.contains('hidden')) {
      el('btnStart').disabled = false;
      alert('Das Spiel wurde serverseitig gestartet, aber es kam keine Rundenzuweisung an. Bitte Seite neu laden und erneut versuchen. Falls das öfter passiert, bitte die Browser-Konsole (F12) beim nächsten Versuch prüfen.');
    }
  }, 6000);
});

el('btnEnableMic').addEventListener('click', async () => {
  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setupAnalyser(state.micStream);
    el('micError').classList.add('hidden');
    const next = state.pendingAfterMic;
    state.pendingAfterMic = null;
    if (next) next();
  } catch (err) {
    el('micError').textContent = 'Mikrofon-Zugriff wurde verweigert oder ist nicht verfügbar. Ohne Mikrofon kann nicht synchronisiert werden – bitte Browser-Berechtigung prüfen.';
    el('micError').classList.remove('hidden');
  }
});

function setupAnalyser(stream) {
  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = state.audioCtx.createMediaStreamSource(stream);
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 512;
  source.connect(state.analyser);
}

let ytApiReady = false;
let ytReadyQueue = [];
function onYouTubeIframeAPIReady() {
  ytApiReady = true;
  ytReadyQueue.forEach((fn) => fn());
  ytReadyQueue = [];
}
function whenYouTubeReady(fn) {
  if (ytApiReady) fn(); else ytReadyQueue.push(fn);
}

function getOrCreateDubPlayer(videoId) {
  return new Promise((resolve) => {
    whenYouTubeReady(() => {
      if (state.ytDub) return resolve(state.ytDub);
      state.ytDub = new YT.Player('ytPlayerDub', {
        width: '100%',
        height: '100%',
        videoId,
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1 },
        events: { onReady: () => resolve(state.ytDub) },
      });
    });
  });
}
function getOrCreateVotePlayer(videoId) {
  return new Promise((resolve) => {
    whenYouTubeReady(() => {
      if (state.ytVote) return resolve(state.ytVote);
      state.ytVote = new YT.Player('ytPlayerVote', {
        width: '100%',
        height: '100%',
        videoId,
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1 },
        events: { onReady: () => resolve(state.ytVote) },
      });
    });
  });
}
function loadVideo(player, videoId) {
  return new Promise((resolve) => {
    player.cueVideoById(videoId);
    const start = Date.now();
    (function check() {
      try {
        const data = player.getVideoData && player.getVideoData();
        if (data && data.video_id === videoId) return resolve();
      } catch (e) { }
      if (Date.now() - start > 4000) return resolve();
      setTimeout(check, 100);
    })();
  });
}

socket.on('round:you', (payload) => {
  state.currentClip = payload.clip;
  state.cuts = [];
  state.skipsUsed = payload.skipsUsed;
  state.skipsAllowed = payload.skipsAllowed;
  state.deadline = payload.deadline;
  el('roundBadge').textContent = `Runde ${payload.round}/${payload.maxRounds}`;
  el('roundBadge').classList.remove('hidden');

  if (!state.micStream) {
    showScreen('screen-mic');
    state.pendingAfterMic = startDubbingFlow;
  } else {
    startDubbingFlow();
  }
});

async function startDubbingFlow() {
  showScreen('screen-dub');
  el('waitingForOthers').classList.add('hidden');
  el('btnSubmitDub').classList.remove('hidden');
  el('btnSubmitDub').disabled = false;
  setClipCredit('dubCredit', state.currentClip);
  updateSkipUI();
  updateCutsCounter();
  startCountdown();
  resetCustomClipForm();

  const player = await getOrCreateDubPlayer(state.currentClip.youtubeId);
  await loadVideo(player, state.currentClip.youtubeId);
  player.mute();
  player.seekTo(state.currentClip.startTime, true);
  playFreely();
}

function setClipCredit(elId, clip) {
  if (!clip) return;
  const parts = [clip.title, clip.license].filter(Boolean);
  el(elId).textContent = parts.length ? `Quelle: ${parts.join(' · ')}` : '';
}

function updateCutsCounter() {
  const n = state.cuts.length;
  el('cutsCounter').textContent = `${n} Einwurf${n === 1 ? '' : 'e'}`;
}

let clipLoopWatcher = null;
function playFreely() {
  const player = state.ytDub;
  el('recordOverlay').classList.add('playing');
  el('recordHint').textContent = state.cuts.length === 0
    ? 'Clip läuft – klick auf „Jetzt sprechen“, wann immer du eine Zeile sagen willst.'
    : 'Aufgenommen! Der Clip läuft weiter – wieder klicken für die nächste Zeile.';
  el('btnRecord').classList.remove('hidden', 'recording');
  el('btnRecord').textContent = '● Jetzt sprechen';
  player.mute();
  player.playVideo();

  clearInterval(clipLoopWatcher);
  clipLoopWatcher = setInterval(() => {
    let t = 0;
    try { t = player.getCurrentTime(); } catch (e) { return; }
    if (t >= state.currentClip.endTime) {
      player.seekTo(state.currentClip.startTime, true);
    }
  }, 200);
}

let mediaChunks = [];
let voiceRingRaf = null;

el('btnRecord').addEventListener('click', () => {
  if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') {
    startCut();
  } else {
    stopCut();
  }
});

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return candidates.find((c) => window.MediaRecorder && MediaRecorder.isTypeSupported(c)) || '';
}

function startCut() {
  const player = state.ytDub;
  let t = state.currentClip.startTime;
  try { t = player.getCurrentTime(); } catch (e) { }
  state.pendingCutTime = t;

  clearInterval(clipLoopWatcher);
  player.pauseVideo();
  el('recordOverlay').classList.remove('playing');
  el('recordHint').textContent = 'Aufnahme läuft… nochmal drücken zum Stoppen.';
  el('btnRecord').classList.add('recording');
  el('btnRecord').textContent = '■ Fertig';

  mediaChunks = [];
  const mimeType = pickMimeType();
  const mr = new MediaRecorder(state.micStream, mimeType ? { mimeType } : undefined);
  state.mediaRecorder = mr;
  mr.ondataavailable = (e) => { if (e.data.size > 0) mediaChunks.push(e.data); };
  mr.onstop = () => {
    cancelAnimationFrame(voiceRingRaf);
    el('voiceRing').style.setProperty('--level', '0');
    const blob = new Blob(mediaChunks, { type: mr.mimeType || 'audio/webm' });
    const reader = new FileReader();
    reader.onload = () => {
      state.cuts.push({ t: state.pendingCutTime, audio: reader.result });
      updateCutsCounter();
      playFreely();
    };
    reader.readAsDataURL(blob);
  };
  mr.start();
  animateVoiceRing();
}
function stopCut() {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') state.mediaRecorder.stop();
}

function animateVoiceRing() {
  const data = new Uint8Array(state.analyser.frequencyBinCount);
  const ring = el('voiceRing');
  const tick = () => {
    if (!state.mediaRecorder || state.mediaRecorder.state !== 'recording') return;
    state.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / data.length);
    ring.style.setProperty('--level', Math.min(1, rms * 4).toFixed(3));
    voiceRingRaf = requestAnimationFrame(tick);
  };
  tick();
}

el('btnSubmitDub').addEventListener('click', async () => {
  if (state.cuts.length === 0) {
    const proceed = confirm('Du hast noch keine Aufnahme gemacht – trotzdem als stummen Clip abgeben?');
    if (!proceed) return;
  }
  el('btnSubmitDub').disabled = true;
  clearInterval(clipLoopWatcher);
  const res = await emitAck('round:submit', { cuts: state.cuts });
  if (!res.ok) { alert(res.error); el('btnSubmitDub').disabled = false; return; }
  el('btnSubmitDub').classList.add('hidden');
  el('waitingForOthers').classList.remove('hidden');
  stopCountdown();
});

async function applyNewClip(clip, skipsUsed) {
  state.currentClip = clip;
  state.cuts = [];
  if (typeof skipsUsed === 'number') state.skipsUsed = skipsUsed;
  updateSkipUI();
  updateCutsCounter();
  setClipCredit('dubCredit', clip);
  el('btnSubmitDub').classList.remove('hidden');
  el('btnSubmitDub').disabled = false;
  const player = state.ytDub;
  await loadVideo(player, clip.youtubeId);
  player.mute();
  player.seekTo(clip.startTime, true);
  playFreely();
}

el('btnSkip').addEventListener('click', async () => {
  const res = await emitAck('round:skip', {});
  if (!res.ok) return alert(res.error);
  await applyNewClip(res.clip, res.skipsUsed);
});

el('btnUseCustomClip').addEventListener('click', async () => {
  const youtubeId = el('customYoutube').value.trim();
  const startTime = Number(el('customStart').value);
  const endTime = Number(el('customEnd').value);
  el('customClipError').classList.add('hidden');
  if (!youtubeId) return showCustomClipError('Bitte einen YouTube-Link oder eine Video-ID eingeben.');
  const res = await emitAck('round:useCustomClip', { youtubeId, startTime, endTime });
  if (!res.ok) return showCustomClipError(res.error);
  document.querySelector('.custom-clip').open = false;
  await applyNewClip(res.clip);
});
function showCustomClipError(msg) {
  const e = el('customClipError');
  e.textContent = msg;
  e.classList.remove('hidden');
}
function resetCustomClipForm() {
  el('customYoutube').value = '';
  el('customClipError').classList.add('hidden');
}

function updateSkipUI() {
  const left = state.skipsAllowed - state.skipsUsed;
  el('skipsLeft').textContent = left;
  el('btnSkip').disabled = left <= 0;
  el('btnSkip').classList.toggle('hidden', state.skipsAllowed === 0);
}

function startCountdown() {
  stopCountdown();
  const tick = () => {
    const remaining = Math.max(0, state.deadline - Date.now());
    el('dubTimer').textContent = formatTime(remaining);
    if (remaining <= 0) stopCountdown();
  };
  tick();
  state.timerInterval = setInterval(tick, 250);
}
function stopCountdown() { clearInterval(state.timerInterval); }
function formatTime(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

socket.on('voting:target', async (payload) => {
  showScreen('screen-vote');
  state.voteTarget = payload;
  state.votedThisTarget = false;
  el('voteProgress').textContent = `${payload.playerName} · Clip ${payload.index + 1}/${payload.total}`;
  el('voteStatus').textContent = '';
  setClipCredit('voteCredit', payload.clip);
  setVoteButtonsEnabled(payload.playerId !== state.playerId);

  const player = await getOrCreateVotePlayer(payload.clip.youtubeId);
  await loadVideo(player, payload.clip.youtubeId);
  player.mute();
  player.seekTo(payload.clip.startTime, true);
});

el('btnPlayDub').addEventListener('click', () => {
  if (state.voteTarget) playDubReconstruction(state.voteTarget);
});

function waitUntilVideoTime(player, targetTime) {
  return new Promise((resolve) => {
    const deadline = Date.now() + 30000;
    (function check() {
      let t = 0;
      try { t = player.getCurrentTime(); } catch (e) { }
      if (t >= targetTime || Date.now() > deadline) return resolve();
      setTimeout(check, 100);
    })();
  });
}

async function playDubReconstruction(target) {
  el('btnPlayDub').disabled = true;
  const player = state.ytVote;
  const clip = target.clip;
  const cuts = (target.cuts || []).slice().sort((a, b) => a.t - b.t);

  player.mute();
  player.seekTo(clip.startTime, true);
  player.playVideo();

  for (const cut of cuts) {
    await waitUntilVideoTime(player, cut.t);
    player.pauseVideo();
    const audioEl = new Audio(cut.audio);
    const audioDone = new Promise((resolve) => {
      audioEl.addEventListener('ended', resolve, { once: true });
      audioEl.addEventListener('error', resolve, { once: true });
    });
    audioEl.play().catch(() => {});
    await Promise.race([audioDone, wait(15000)]);
    player.mute();
    player.playVideo();
  }
  await waitUntilVideoTime(player, clip.endTime);
  player.pauseVideo();
  el('btnPlayDub').disabled = false;
}

document.querySelectorAll('.vote-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (state.votedThisTarget || !state.voteTarget) return;
    const vote = btn.dataset.vote;
    const res = await emitAck('voting:vote', { targetPlayerId: state.voteTarget.playerId, vote });
    if (!res.ok) return alert(res.error);
    state.votedThisTarget = true;
    setVoteButtonsEnabled(false);
    el('voteStatus').textContent = 'Stimme abgegeben – warte auf die anderen…';
  });
});
function setVoteButtonsEnabled(enabled) {
  document.querySelectorAll('.vote-btn').forEach((b) => { b.disabled = !enabled; });
}
socket.on('voting:progress', ({ votesSoFar, votesNeeded }) => {
  if (!state.votedThisTarget) return;
  el('voteStatus').textContent = `${votesSoFar}/${votesNeeded} haben abgestimmt…`;
});

socket.on('round:results', ({ leaderboard }) => {
  showScreen('screen-round-results');
  renderLeaderboard('leaderboard', leaderboard);
  el('btnNextRound').classList.toggle('hidden', !state.isHost);
  el('waitingForHostResults').classList.toggle('hidden', state.isHost);
});

el('btnNextRound').addEventListener('click', async () => {
  el('btnNextRound').disabled = true;
  const res = await emitAck('game:next', {});
  el('btnNextRound').disabled = false;
  if (!res.ok) alert(res.error);
});

function renderLeaderboard(listId, entries) {
  const list = el(listId);
  list.innerHTML = '';
  entries.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="rank">#${i + 1}</span>${escapeHtml(p.name)}</span><span class="score">${p.score} Pkt.</span>`;
    list.appendChild(li);
  });
}

socket.on('game:over', ({ leaderboard }) => {
  showScreen('screen-gameover');
  renderLeaderboard('finalLeaderboard', leaderboard);
});
el('btnRestart').addEventListener('click', () => window.location.reload());
