import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { GameRoom } from './game/GameRoom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const skinsDir = path.join(rootDir, 'client', 'assets', 'skins');

/**
 * Lista las skins disponibles a partir de los .png en client/assets/skins/
 * — el nombre del archivo (sin extensión) es el nombre de la skin.
 */
function listSkins() {
  try {
    return fs
      .readdirSync(skinsDir)
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Solo binario/JSON pequeño; sin CORS externo (mismo origen en Render).
  serveClient: true,
});

// Cache de estáticos solo en producción (en dev rompe la iteración).
const staticMaxAge = process.env.NODE_ENV === 'production' ? '1h' : 0;
app.use(express.static(path.join(rootDir, 'client'), { maxAge: staticMaxAge, index: 'index.html' }));
app.use('/shared', express.static(path.join(rootDir, 'shared'), { maxAge: staticMaxAge }));
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/api/skins', (_req, res) => res.json(listSkins()));

const room = new GameRoom(io);

io.on('connection', (socket) => {
  socket.on('join', (payload) => {
    const nickname = String(payload?.nickname ?? '').trim().slice(0, 16);
    if (!nickname) return socket.emit('joinError', 'Nickname inválido');
    // Se valida contra la lista real de archivos — nunca se confía en el
    // string que manda el cliente para construir una ruta.
    const skins = listSkins();
    const requested = String(payload?.skin ?? '');
    const skin = skins.includes(requested) ? requested : (skins.includes('steve') ? 'steve' : skins[0]);
    const position = payload?.position === 'GK' ? 'GK' : 'FIELD';
    room.addPlayer(socket, nickname, skin, position);
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
