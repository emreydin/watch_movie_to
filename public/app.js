const socket = io();
const player = document.getElementById('player');
const statusEl = document.getElementById('status');
const urlInput = document.getElementById('videoUrl');

let roomId = location.hash.slice(1);
if (!roomId) {
  roomId = Math.random().toString(36).slice(2, 8);
  location.hash = roomId;
}

// --- Döngüyü önleme: uzaktan gelen komutun tetiklediği olayları yoksay ---
const suppress = { play: false, pause: false, seek: false };
function suppressFor(name) {
  suppress[name] = true;
  setTimeout(() => (suppress[name] = false), 1000); // olay hiç gelmezse takılı kalmasın
}

let pendingState = null; // video yüklenince uygulanacak durum

function applyRemote({ type, time }) {
  if (Math.abs(player.currentTime - time) > 0.3) {
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

// --- Yerel olaylar -> karşı tarafa gönder ---
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

// --- Sunucudan gelenler ---
socket.on('connect', () => {
  socket.emit('join-room', roomId);
});

socket.on('joined', ({ videoUrl, userCount, state }) => {
  statusEl.textContent = `Odada ${userCount}/2 kişi (oda: ${roomId})`;
  if (videoUrl) {
    pendingState = state;
    player.src = videoUrl;
    urlInput.value = videoUrl;
  } else if (urlInput.value.trim()) {
    // sunucu yeniden başladıysa ve bu sekmede link duruyorsa odaya geri ekle
    socket.emit('set-video', urlInput.value.trim());
  }
});

player.addEventListener('loadedmetadata', () => {
  if (pendingState) {
    applyRemote({ type: pendingState.playing ? 'play' : 'pause', time: pendingState.time });
    pendingState = null;
  }
});

socket.on('sync-action', applyRemote);

socket.on('peer-joined', () => (statusEl.textContent = 'Arkadaşın odaya girdi (2/2)'));
socket.on('peer-left', () => (statusEl.textContent = 'Arkadaşın ayrıldı (1/2)'));
socket.on('room-full', () => (statusEl.textContent = 'Oda dolu!'));

socket.on('video-changed', (url) => {
  player.src = url;
  urlInput.value = url;
});

document.getElementById('loadBtn').addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (url) socket.emit('set-video', url);
});

// --- Hata görünürlüğü ---
player.addEventListener('error', () => {
  const codes = { 1: 'iptal edildi', 2: 'ağ hatası', 3: 'çözülemedi (codec)', 4: 'kaynak desteklenmiyor veya link hatalı' };
  const code = player.error ? player.error.code : '?';
  statusEl.textContent = `Video hatası: ${codes[code] || code}`;
});

// ================= Kamera & Mikrofon (WebRTC) =================
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const camBtn = document.getElementById('camBtn');
const micBtn = document.getElementById('micBtn');

let localStream = null;
let pc = null;

// Kamera/mikrofon izni: sayfa açılır açılmaz istenir
async function getMedia() {
  if (!navigator.mediaDevices) {
    statusEl.textContent = 'Tarayıcı kamera API\'sini vermiyor (adres http://localhost:3000 olmalı)';
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    console.error('Medya hatası:', err.name, err.message);
    statusEl.textContent = `Kamera/mikrofon hatası: ${err.name}`;
    try {
      // Sadece mikrofonla dene
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      statusEl.textContent += ' (sadece mikrofon açıldı)';
    } catch (e) {
      console.error('Sadece mikrofon da olmadı:', e.name);
      return;
    }
  }
  localVideo.srcObject = localStream;
}
const mediaReady = getMedia();

function closePeer() {
  if (pc) { pc.close(); pc = null; }
  remoteVideo.srcObject = null;
}

function createPeer() {
  closePeer();
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  if (localStream) {
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  } else {
    // İzin verilmediyse en azından karşıyı görebilelim
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'recvonly' });
  }

  pc.ontrack = (e) => { remoteVideo.srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { candidate: e.candidate });
  };
  return pc;
}

// Odaya sonradan giren kişiyi odadaki kişi arar (offer gönderir)
socket.on('peer-joined', async () => {
  await mediaReady;
  createPeer();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { description: pc.localDescription });
});

async function handleSignal({ description, candidate }) {
  if (description) {
    if (description.type === 'offer') {
      await mediaReady;
      createPeer();
      await pc.setRemoteDescription(description);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { description: pc.localDescription });
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

socket.on('peer-left', closePeer);

// Aç/kapat butonları
camBtn.addEventListener('click', () => {
  const track = localStream && localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  camBtn.textContent = track.enabled ? 'Kamerayı kapat' : 'Kamerayı aç';
});

micBtn.addEventListener('click', () => {
  const track = localStream && localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micBtn.textContent = track.enabled ? 'Mikrofonu kapat' : 'Mikrofonu aç';
});

// ================= Film kütüphanesi =================
const movieSelect = document.getElementById('movieSelect');

fetch('/api/movies')
  .then((r) => r.json())
  .then((movies) => {
    movies.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.url;
      opt.textContent = m.name;
      movieSelect.appendChild(opt);
    });
  })
  .catch((e) => console.error('Film listesi alınamadı', e));

document.getElementById('movieBtn').addEventListener('click', () => {
  if (movieSelect.value) socket.emit('set-video', movieSelect.value);
});