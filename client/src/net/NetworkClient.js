import { io } from '/socket.io/socket.io.esm.min.js';
import { NET } from '/shared/constants.js';

/**
 * Capa de red: Socket.IO, buffer de snapshots para interpolación
 * y envío del estado local a tasa fija.
 */
export class NetworkClient {
  constructor() {
    this.socket = io({ transports: ['websocket'] }); // solo WS: menos latencia/overhead
    this.snapshots = []; // buffer ordenado por tiempo
    this.serverTimeOffset = 0;
    this.myId = null;
    this.handlers = {};

    this.socket.on('snap', (snap) => {
      this.serverTimeOffset = snap.t - performance.now();
      this.snapshots.push(snap);
      if (this.snapshots.length > 30) this.snapshots.shift();
    });

    for (const ev of ['joined', 'joinError', 'playerJoined', 'playerLeft', 'goal', 'foul', 'steal', 'kicked', 'possession']) {
      this.socket.on(ev, (data) => this.handlers[ev]?.(data));
    }
  }

  on(event, fn) {
    this.handlers[event] = fn;
  }

  join(nickname, skin) {
    this.socket.emit('join', { nickname, skin });
  }

  sendState(pos, yaw, anim, sprinting) {
    this.socket.emit('state', [
      +pos.x.toFixed(2),
      +pos.y.toFixed(2),
      +pos.z.toFixed(2),
      +yaw.toFixed(3),
      anim,
      sprinting ? 1 : 0,
    ]);
  }

  /** pos: posición actual del jugador — el balón sale desde su frente. */
  sendKick(yaw, power, pos) {
    this.socket.emit('kick', {
      yaw,
      power,
      pos: pos ? [+pos.x.toFixed(2), +pos.z.toFixed(2)] : undefined,
    });
  }

  sendChallenge(type) {
    this.socket.emit('challenge', { type });
  }

  /**
   * Devuelve un par de snapshots (a, b, alpha) para interpolar el estado
   * remoto en renderTime = ahora - INTERP_DELAY.
   */
  getInterpolationPair() {
    const renderTime = performance.now() + this.serverTimeOffset - NET.INTERP_DELAY_MS;
    const snaps = this.snapshots;
    if (snaps.length === 0) return null;
    if (snaps.length === 1 || renderTime <= snaps[0].t) {
      return { a: snaps[0], b: snaps[0], alpha: 0 };
    }
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i - 1].t <= renderTime) {
        const a = snaps[i - 1];
        const b = snaps[i];
        const span = Math.max(1, b.t - a.t);
        return { a, b, alpha: Math.min(1, (renderTime - a.t) / span) };
      }
    }
    const last = snaps[snaps.length - 1];
    return { a: last, b: last, alpha: 0 };
  }
}
