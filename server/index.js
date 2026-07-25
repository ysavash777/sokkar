import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { GameRoom } from './game/GameRoom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Solo binario/JSON pequeño; sin CORS externo (mismo origen en Render).
  serveClient: true,
});

app.use(express.static(path.join(rootDir, 'client'), { maxAge: '1h', index: 'index.html' }));
app.use('/shared', express.static(path.join(rootDir, 'shared'), { maxAge: '1h' }));
app.get('/healthz', (_req, res) => res.send('ok'));

const room = new GameRoom(io);

io.on('connection', (socket) => {
  socket.on('join', (payload) => {
    const nickname = String(payload?.nickname ?? '').trim().slice(0, 16);
    if (!nickname) return socket.emit('joinError', 'Nickname inválido');
    room.addPlayer(socket, nickname);
  });

  socket.on('state', (data) => room.onPlayerState(socket.id, data));
  socket.on('kick', (data) => room.onKick(socket.id, data));
  socket.on('challenge', (data) => room.onChallenge(socket.id, data));
  socket.on('disconnect', () => room.removePlayer(socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[sokkaio] servidor escuchando en :${PORT}`);
});
