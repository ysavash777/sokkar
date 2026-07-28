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
    this.ping = 0; // ms, RTT medido — ver pingCheck/pongCheck

    this.socket.on('snap', (snap) => {
      this.serverTimeOffset = snap.t - performance.now();
      this.snapshots.push(snap);
      if (this.snapshots.length > 30) this.snapshots.shift();
    });

    // Ping: eco simple con el propio timestamp del cliente, sin depender
    // del reloj del servidor.
    this.socket.on('pongCheck', (ts) => {
      this.ping = Math.round(performance.now() - ts);
    });
    setInterval(() => {
      if (this.socket.connected) this.socket.emit('pingCheck', performance.now());
    }, 2000);

    for (const ev of ['joined', 'joinError', 'playerJoined', 'playerLeft', 'goal', 'foul', 'steal', 'kicked', 'possession', 'caught', 'playerUpdated']) {
      this.socket.on(ev, (data) => this.handlers[ev]?.(data));
    }
  }

  on(event, fn) {
    this.handlers[event] = fn;
  }

  join(nickname, skin, position) {
    this.socket.emit('join', { nickname, skin, position });
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

  /**
   * pos: posición actual del jugador — el balón sale desde su frente.
   * pitch: cámara (altura del remate). vel: velocidad real del jugador
   * [vx, vz] — el servidor la suma al impulso (Primera Ley de Newton).
   */
  sendKick(yaw, power, pos, pitch, vel) {
    this.socket.emit('kick', {
      yaw,
      power,
      pos: pos ? [+pos.x.toFixed(2), +pos.z.toFixed(2)] : undefined,
      pitch: Number.isFinite(pitch) ? +pitch.toFixed(3) : undefined,
      vel: Array.isArray(vel) && vel.every(Number.isFinite) ? [+vel[0].toFixed(2), +vel[1].toFixed(2)] : undefined,
    });
  }

  sendChallenge(type, extra) {
    this.socket.emit('challenge', { type, ...extra });
  }

  /** Cambio de skin/posición EN PARTIDA, sin pasar por la pantalla de nickname. */
  changeLoadout(skin, position) {
    this.socket.emit('changeLoadout', { skin, position });
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
