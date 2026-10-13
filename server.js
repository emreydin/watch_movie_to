const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
const MOVIES_DIR = path.join(__dirname, 'public', 'movies');
const VIDEO_EXT = ['.mp4', '.webm', '.m4v'];

// Film listesi: public/movies klasörü + (varsa) movies.json içindeki uzak linkler
app.get('/api/movies', (req, res) => {
  let local = [];
  try {
    local = fs
      .readdirSync(MOVIES_DIR)
      .filter((f) => VIDEO_EXT.includes(path.extname(f).toLowerCase()))
      .map((f) => ({
        name: path.parse(f).name.replace(/_/g, ' '),
        url: '/movies/' + encodeURIComponent(f),
      }));
  } catch (e) { /* klasör yoksa boş liste */ }

  let remote = [];
  try {
    remote = JSON.parse(fs.readFileSync(path.join(__dirname, 'movies.json'), 'utf8'));
  } catch (e) { /* dosya yoksa boş */ }

  res.json([...local, ...remote]);
});

// roomId -> { users, videoUrl, state: { playing, time, updatedAt } }
const rooms = {};

function currentTime(state) {
  if (!state.playing) return state.time;
  return state.time + (Date.now() - state.updatedAt) / 1000;
}

io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => {
    const room =
      rooms[roomId] ||
      (rooms[roomId] = {
        users: [],
        videoUrl: null,
        state: { playing: false, time: 0, updatedAt: Date.now() },
      });

    if (room.users.length >= 2) {
      socket.emit('room-full');
      return;
    }

    room.users.push(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined', {
      videoUrl: room.videoUrl,
      userCount: room.users.length,
      state: { playing: room.state.playing, time: currentTime(room.state) },
    });
    socket.to(roomId).emit('peer-joined');
  });

  socket.on('set-video', (url) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    rooms[roomId].videoUrl = url;
    rooms[roomId].state = { playing: false, time: 0, updatedAt: Date.now() };
    io.to(roomId).emit('video-changed', url);
  });

  // type: 'play' | 'pause' | 'seek'
  socket.on('sync-action', ({ type, time }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    const playing =
      type === 'play' ? true : type === 'pause' ? false : room.state.playing;
    room.state = { playing, time, updatedAt: Date.now() };

    socket.to(roomId).emit('sync-action', { type, time });
  });
  
    // WebRTC sinyalleşmesi: mesajı odadaki diğer kişiye ilet
  socket.on('signal', (data) => {
    const roomId = socket.data.roomId;
    if (roomId) socket.to(roomId).emit('signal', data);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    rooms[roomId].users = rooms[roomId].users.filter((id) => id !== socket.id);
    socket.to(roomId).emit('peer-left');
    if (rooms[roomId].users.length === 0) delete rooms[roomId];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));