const socket = io();

// ---------- Elemanlar ----------
const player = document.getElementById('player');
const stage = document.getElementById('stage');
const statusEl = document.getElementById('status');
const movieSelect = document.getElementById('movieSelect');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const localTile = document.getElementById('localTile');
const remoteTile = document.getElementById('remoteTile');
const remoteBadges = document.getElementById('remoteBadges');
const camBtn = document.getElementById('camBtn');
const micBtn = document.getElementById('micBtn');

// ---------- Durum ----------
let localStream = null;
let pc = null;
let peerPresent = false;
let camOn = true;
let micOn = true;
let remoteState = { cam: true, mic: true };
let remoteHasStream = false;
let currentVideoUrl = null;
let pendingState = null;

// ---------- Oda ----------
let roomId = location.hash.slice(1);
if (!roomId) {
  roomId = Math.random().toString(36).slice(2, 8);
  location.hash = roomId;
}

socket.on('connect', () => socket.emit('join-room', roomId));

socket.on('joined', ({ userCount, videoUrl, state }) => {
  peerPresent = userCount > 1;
  statusEl.textContent = `Odada ${userCount}/2 kişi (oda: ${roomId})`;
  if (videoUrl) {
    pendingState = state;
    loadVideo(videoUrl);
  }
});
socket.on('room-full', () => (statusEl.textContent = 'Oda dolu!'));

// ---------- Film seç (açılır liste) ----------z
function loadVideo(url) {
  currentVideoUrl = url;
  player.src = url;
  stage.classList.add('has-video');
  if ([...movieSelect.options].some((o) => o.value === url)) movieSelect.value = url;
}

fetch('/api/movies')
  .then((r) => r.json())
  .then((movies) => {
    movies.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.url;
      opt.textContent = m.name;
      movieSelect.appendChild(opt);
    });
    if (currentVideoUrl && [...movieSelect.options].some((o) => o.value === currentVideoUrl)) {
      movieSelect.value = currentVideoUrl;
    }
  })
  .catch((e) => console.error('Film listesi alınamadı', e));

movieSelect.addEventListener('change', () => {
  if (movieSelect.value) socket.emit('set-video', movieSelect.value);
});

socket.on('video-changed', (url) => loadVideo(url));

// Odaya sonradan girince filmin o anki yerine ve durumuna atla
player.addEventListener('loadedmetadata', () => {
  if (pendingState) {
    applyRemote({ type: pendingState.playing ? 'play' : 'pause', time: pendingState.time });
    pendingState = null;
  }
});

player.addEventListener('error', () => {
  statusEl.textContent = 'Video açılamadı (format desteklenmiyor olabilir)';
});

// ---------- Oynat / durdur / ileri sar senkronizasyonu ----------
const suppress = { play: false, pause: false, seek: false };
function suppressFor(name) {
  suppress[name] = true;
  setTimeout(() => (suppress[name] = false), 1000);
}

function applyRemote({ type, time }) {
  if (time != null && Math.abs(player.currentTime - time) > 0.3) {
    suppressFor('seek');
    player.currentTime = time;
  }
  if (type === 'play' && player.paused) {
    suppressFor('play');
    player.play().catch(() => {
      statusEl.textContent = 'Oynatmak için sayfaya bir kez tıkla (tarayıcı engeli)';
    });
  }
  if (type === 'pause' && !player.paused) {
    suppressFor('pause');
    player.pause();
  }
}

player.addEventListener('play', () => {
  if (suppress.play) { suppress.play = false; return; }
  socket.emit('sync-action', { type: 'play', time: player.currentTime });
});
player.addEventListener('pause', () => {
  if (suppress.pause) { suppress.pause = false; return; }
  socket.emit('sync-action', { type: 'pause', time: player.currentTime });
});
player.addEventListener('seeked', () => {
  if (suppress.seek) { suppress.seek = false; return; }
  socket.emit('sync-action', { type: 'seek', time: player.currentTime });
});

socket.on('sync-action', applyRemote);

// ---------- Kamera kutuları ----------
function setPlaceholder(tile, text) {
  const ph = tile.querySelector('.placeholder');
  if (text) {
    ph.textContent = text;
    tile.classList.add('show-placeholder');
  } else {
    tile.classList.remove('show-placeholder');
  }
}

function renderRemote() {
  remoteBadges.innerHTML = remoteState.mic ? '' : '<span class="badge">🔇 Mikrofon kapalı</span>';
  if (!remoteHasStream) setPlaceholder(remoteTile, 'Bekleniyor...');
  else setPlaceholder(remoteTile, remoteState.cam ? null : 'Kamera kapalı');
}

function renderLocalControls() {
  camBtn.classList.toggle('off', !camOn);
  camBtn.textContent = camOn ? '📷' : '🚫';
  micBtn.classList.toggle('off', !micOn);
  micBtn.textContent = micOn ? '🎤' : '🔇';
  const hasCam = localStream && localStream.getVideoTracks().length > 0;
  setPlaceholder(localTile, !hasCam ? 'Kamera yok' : camOn ? null : 'Kamera kapalı');
}

function sendMediaState() {
  socket.emit('signal', { mediaState: { cam: camOn, mic: micOn } });
}

camBtn.addEventListener('click', () => {
  const track = localStream && localStream.getVideoTracks()[0];
  if (!track) return;
  camOn = !camOn;
  track.enabled = camOn;
  renderLocalControls();
  sendMediaState();
});

micBtn.addEventListener('click', () => {
  const track = localStream && localStream.getAudioTracks()[0];
  if (!track) return;
  micOn = !micOn;
  track.enabled = micOn;
  renderLocalControls();
  sendMediaState();
});

// ---------- Kamera ve mikrofon izni ----------
async function getMedia() {
  if (!navigator.mediaDevices) {
    statusEl.textContent = "Tarayıcı kamera API'sini vermiyor (adres https ya da localhost olmalı)";
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    console.error('Medya hatası:', err.name, err.message);
    statusEl.textContent = `Kamera/mikrofon hatası: ${err.name}`;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.error('Sadece mikrofon da olmadı:', e.name);
    }
  }
  if (localStream) localVideo.srcObject = localStream;
  camBtn.disabled = !(localStream && localStream.getVideoTracks().length);
  micBtn.disabled = !(localStream && localStream.getAudioTracks().length);
  renderLocalControls();
}
const mediaReady = getMedia();

// ---------- WebRTC bağlantısı ----------
function closePeer() {
  if (pc) { pc.close(); pc = null; }
  remoteVideo.srcObject = null;
  remoteHasStream = false;
  remoteState = { cam: true, mic: true };
  renderRemote();
}

function createPeer() {
  closePeer();
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  if (localStream) {
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  } else {
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'recvonly' });
  }

  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
    remoteHasStream = true;
    renderRemote();
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { candidate: e.candidate });
  };
  return pc;
}

// Odaya sonradan girene, odadaki kişi arama (offer) gönderir
socket.on('peer-joined', async () => {
  peerPresent = true;
  statusEl.textContent = 'Arkadaşın odaya girdi (2/2)';
  await mediaReady;
  sendMediaState();
  createPeer();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { description: pc.localDescription });
});

socket.on('peer-left', () => {
  peerPresent = false;
  statusEl.textContent = 'Arkadaşın ayrıldı (1/2)';
  closePeer();
});

async function handleSignal(data) {
  if (data.mediaState) {
    remoteState = data.mediaState;
    renderRemote();
    return;
  }
  const { description, candidate } = data;
  if (description) {
    if (description.type === 'offer') {
      await mediaReady;
      createPeer();
      await pc.setRemoteDescription(description);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { description: pc.localDescription });
      sendMediaState();
    } else if (pc) {
      await pc.setRemoteDescription(description);
    }
  } else if (candidate && pc) {
    await pc.addIceCandidate(candidate);
  }
}

// Mesajları sırayla işle (adaylar teklifi geçmesin)
let signalChain = Promise.resolve();
socket.on('signal', (data) => {
  signalChain = signalChain.then(() => handleSignal(data)).catch(console.error);
});

// Tarayıcı otomatik oynatmayı engellediyse, ilk tıklamada karşı sesi başlat
document.addEventListener('click', () => {
  if (remoteVideo.srcObject && remoteVideo.paused) remoteVideo.play().catch(() => {});
});

renderRemote();