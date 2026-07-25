/**
 * Sala única 4v4. Autoridad del servidor:
 *  - Física del balón (vuelo, rebotes, goles).
 *  - Posesión / conducción (el balón "pegado" a los pies).
 *  - Resolución de robos y faltas (cruzar pie / barrida).
 * Los jugadores son client-authoritative en su movimiento (con clamps),
 * el servidor retransmite snapshots a 20 Hz.
 */
import { FIELD, BALL, DRIBBLE, ACTIONS, NET, ANIM, PLAYER } from '../../shared/constants.js';
import { stepBall, collideBallWithPlayer } from './physics.js';

const HALF_L = FIELD.LENGTH / 2;
const HALF_W = FIELD.WIDTH / 2;

const SPAWNS = [
  // Fracciones del medio campo propio [x, z]; se espeja para el equipo 1.
  [-0.85, 0],
  [-0.5, -0.5],
  [-0.5, 0.5],
  [-0.25, 0],
];

export class GameRoom {
  constructor(io) {
    this.io = io;
    this.players = new Map(); // socketId -> player
    this.ball = { pos: { x: 0, y: BALL.RADIUS, z: 0 }, vel: { x: 0, y: 0, z: 0 }, ownerId: null };
    this.score = [0, 0];
    this.kickoffFreezeUntil = 0;

    const dt = 1 / NET.SERVER_TICK_HZ;
    setInterval(() => this.tick(dt), 1000 / NET.SERVER_TICK_HZ);
    setInterval(() => this.broadcastSnapshot(), 1000 / NET.SNAPSHOT_HZ);
  }

  // ---------------------------------------------------------------- lobby

  addPlayer(socket, nickname) {
    if (this.players.has(socket.id)) return;
    if (this.players.size >= NET.MAX_PLAYERS) {
      socket.emit('joinError', 'La partida está llena (4v4).');
      return;
    }
    const team = this.pickTeam();
    const spawn = this.spawnFor(team, this.teamCount(team));
    const player = {
      id: socket.id,
      nickname,
      team,
      pos: { x: spawn.x, y: 0, z: spawn.z },
      yaw: team === 0 ? Math.PI / 2 : -Math.PI / 2,
      anim: ANIM.IDLE,
      sprinting: false,
      moving: false,
      stunnedUntil: 0,
      lastKickAt: 0,
      challenge: null, // { type, until, cooldownUntil, fouled }
      challengeCooldownUntil: 0,
    };
    this.players.set(socket.id, player);

    socket.emit('joined', {
      id: socket.id,
      team,
      spawn,
      score: this.score,
      players: this.publicPlayers(),
    });
    socket.broadcast.emit('playerJoined', this.publicPlayer(player));
    console.log(`[sokkaio] ${nickname} entró (equipo ${team}) — ${this.players.size} jugadores`);
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.ball.ownerId === id) this.ball.ownerId = null;
    this.players.delete(id);
    this.io.emit('playerLeft', id);
    console.log(`[sokkaio] ${p.nickname} salió — ${this.players.size} jugadores`);
  }

  pickTeam() {
    return this.teamCount(0) <= this.teamCount(1) ? 0 : 1;
  }

  teamCount(team) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
  }

  spawnFor(team, index) {
    const [fx, fz] = SPAWNS[index % SPAWNS.length];
    const sign = team === 0 ? 1 : -1;
    return { x: fx * HALF_L * sign, z: fz * HALF_W * 0.8 };
  }

  publicPlayer(p) {
    return { id: p.id, nickname: p.nickname, team: p.team };
  }

  publicPlayers() {
    return [...this.players.values()].map((p) => this.publicPlayer(p));
  }

  // ---------------------------------------------------------------- inputs

  onPlayerState(id, data) {
    const p = this.players.get(id);
    if (!p || !Array.isArray(data)) return;
    const [x, y, z, yaw, anim, sprinting] = data;
    if (![x, y, z, yaw].every(Number.isFinite)) return;
    // Clamps anti-trampa básicos: dentro del área jugable.
    p.pos.x = Math.max(-HALF_L - 1, Math.min(HALF_L + 1, x));
    p.pos.y = Math.max(0, Math.min(4, y));
    p.pos.z = Math.max(-HALF_W - 1, Math.min(HALF_W + 1, z));
    p.yaw = yaw;
    p.anim = anim | 0;
    p.sprinting = !!sprinting;
    p.moving = p.anim === ANIM.JOG || p.anim === ANIM.SPRINT;
  }

  onKick(id, data) {
    const p = this.players.get(id);
    if (!p) return;
    const now = Date.now();
    if (now < p.stunnedUntil || now < this.kickoffFreezeUntil) return;
    if (now - p.lastKickAt < ACTIONS.KICK_COOLDOWN_MS) return;

    const ball = this.ball;
    const dx = ball.pos.x - p.pos.x;
    const dz = ball.pos.z - p.pos.z;
    const withinRange = dx * dx + dz * dz < ACTIONS.KICK_RANGE * ACTIONS.KICK_RANGE;
    if (ball.ownerId !== id && !withinRange) return;

    const dirYaw = Number.isFinite(data?.yaw) ? data.yaw : p.yaw;
    const power = Math.max(0.3, Math.min(1, Number(data?.power) || 1));
    p.lastKickAt = now;
    ball.ownerId = null;
    ball.vel.x = Math.sin(dirYaw) * ACTIONS.KICK_POWER * power;
    ball.vel.z = Math.cos(dirYaw) * ACTIONS.KICK_POWER * power;
    ball.vel.y = ACTIONS.KICK_LIFT * power;
    this.io.emit('kicked', { id });
  }

  /** Cruzar pie (extend) o barrida (slide). El robo/falta se evalúa en el tick. */
  onChallenge(id, data) {
    const p = this.players.get(id);
    if (!p) return;
    const now = Date.now();
    const type = data?.type === 'slide' ? 'slide' : 'extend';
    if (now < p.stunnedUntil || now < p.challengeCooldownUntil || p.challenge) return;

    const duration = type === 'slide' ? ACTIONS.SLIDE_DURATION_MS : ACTIONS.EXTEND_DURATION_MS;
    const cooldown = type === 'slide' ? ACTIONS.SLIDE_COOLDOWN_MS : ACTIONS.EXTEND_COOLDOWN_MS;
    p.challenge = { type, until: now + duration, resolved: false };
    p.challengeCooldownUntil = now + cooldown;
  }

  // ---------------------------------------------------------------- tick

  tick(dt) {
    const now = Date.now();
    const ball = this.ball;

    // Resolver desafíos activos (cruzar pie / barrida).
    for (const p of this.players.values()) {
      if (!p.challenge) continue;
      if (now > p.challenge.until) {
        p.challenge = null;
        continue;
      }
      if (!p.challenge.resolved) this.resolveChallenge(p, now);
    }

    if (ball.ownerId) {
      this.dribble(dt, now);
    } else {
      const goal = stepBall(ball, dt);
      if (goal !== 0) {
        this.onGoal(goal === 1 ? 0 : 1);
        return;
      }
      // Colisión por extremidades con cada jugador (solo balón libre).
      for (const p of this.players.values()) {
        collideBallWithPlayer(ball, p);
      }
      this.tryCapture(now);
    }
  }

  /** El balón sigue el punto de control frente a los pies del dueño. */
  dribble(dt, now) {
    const owner = this.players.get(this.ball.ownerId);
    if (!owner || now < owner.stunnedUntil) {
      this.ball.ownerId = null;
      return;
    }
    const dist = !owner.moving
      ? DRIBBLE.DIST_IDLE
      : owner.sprinting
        ? DRIBBLE.DIST_SPRINT
        : DRIBBLE.DIST_JOG;
    const tx = owner.pos.x + Math.sin(owner.yaw) * dist;
    const tz = owner.pos.z + Math.cos(owner.yaw) * dist;

    const k = 1 - Math.exp(-DRIBBLE.FOLLOW_RATE * dt);
    const ball = this.ball;
    ball.pos.x += (tx - ball.pos.x) * k;
    ball.pos.z += (tz - ball.pos.z) * k;
    ball.pos.y += (BALL.RADIUS - ball.pos.y) * k;
    ball.vel.x = ball.vel.z = ball.vel.y = 0;

    // Si el dueño saltó o quedó lejos (lag/teleport), suelta el balón.
    const dx = ball.pos.x - owner.pos.x;
    const dz = ball.pos.z - owner.pos.z;
    if (dx * dx + dz * dz > 6.25 || owner.pos.y > 0.6) this.ball.ownerId = null;
  }

  tryCapture(now) {
    if (now < this.kickoffFreezeUntil) return;
    const ball = this.ball;
    if (ball.pos.y > DRIBBLE.MAX_CAPTURE_HEIGHT) return;
    const speed = Math.hypot(ball.vel.x, ball.vel.z);
    if (speed > DRIBBLE.MAX_CAPTURE_SPEED) return;

    let best = null;
    let bestDistSq = DRIBBLE.CONTROL_RADIUS * DRIBBLE.CONTROL_RADIUS;
    for (const p of this.players.values()) {
      if (now < p.stunnedUntil || p.pos.y > 0.4) continue;
      if (now - p.lastKickAt < ACTIONS.KICK_COOLDOWN_MS) continue; // no re-capturar el propio pase al instante
      const dx = ball.pos.x - p.pos.x;
      const dz = ball.pos.z - p.pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestDistSq) {
        bestDistSq = d;
        best = p;
      }
    }
    if (best) {
      ball.ownerId = best.id;
      this.io.emit('possession', { id: best.id });
    }
  }

  /**
   * Regla de cruzar pie / barrida:
   *  1) Si el pie extendido conecta con la PELOTA -> robo limpio.
   *  2) Si en cambio conecta con pie/pierna del RIVAL -> falta.
   */
  resolveChallenge(p, now) {
    const c = p.challenge;
    const reach = c.type === 'slide' ? ACTIONS.SLIDE_REACH : ACTIONS.EXTEND_REACH;
    const footX = p.pos.x + Math.sin(p.yaw) * reach;
    const footZ = p.pos.z + Math.cos(p.yaw) * reach;
    const ball = this.ball;

    // 1) ¿Conecta con la pelota?
    const bdx = ball.pos.x - footX;
    const bdz = ball.pos.z - footZ;
    if (
      ball.pos.y < 0.9 &&
      bdx * bdx + bdz * bdz < ACTIONS.STEAL_RADIUS * ACTIONS.STEAL_RADIUS &&
      ball.ownerId !== p.id
    ) {
      const prevOwner = this.players.get(ball.ownerId);
      c.resolved = true;
      if (c.type === 'slide') {
        // La barrida despeja el balón hacia adelante.
        ball.ownerId = null;
        ball.vel.x = Math.sin(p.yaw) * 7;
        ball.vel.z = Math.cos(p.yaw) * 7;
        ball.vel.y = 1.5;
      } else {
        ball.ownerId = p.id;
      }
      this.io.emit('steal', {
        by: p.id,
        from: prevOwner ? prevOwner.id : null,
        type: c.type,
      });
      return;
    }

    // 2) ¿Conecta con la pierna/pie de un rival (sin haber tocado la pelota)?
    for (const rival of this.players.values()) {
      if (rival.team === p.team || rival.id === p.id) continue;
      const dx = rival.pos.x - footX;
      const dz = rival.pos.z - footZ;
      const legRadius = ACTIONS.FOUL_RADIUS;
      if (dx * dx + dz * dz < legRadius * legRadius && rival.pos.y < 0.6) {
        c.resolved = true;
        p.stunnedUntil = now + ACTIONS.FOUL_STUN_MS;
        p.challenge = null;
        // Si la víctima tenía el balón, lo conserva; si era libre, se lo queda.
        if (!this.ball.ownerId || this.ball.ownerId === p.id) this.ball.ownerId = rival.id;
        this.io.emit('foul', {
          offender: p.id,
          victim: rival.id,
          type: c.type,
          stunMs: ACTIONS.FOUL_STUN_MS,
        });
        return;
      }
    }
  }

  onGoal(scoringTeam) {
    this.score[scoringTeam]++;
    this.ball.ownerId = null;
    this.ball.pos = { x: 0, y: BALL.RADIUS, z: 0 };
    this.ball.vel = { x: 0, y: 0, z: 0 };
    this.kickoffFreezeUntil = Date.now() + 2500;

    const spawns = {};
    let idx = [0, 0];
    for (const p of this.players.values()) {
      const s = this.spawnFor(p.team, idx[p.team]++);
      p.pos = { x: s.x, y: 0, z: s.z };
      spawns[p.id] = s;
    }
    this.io.emit('goal', { team: scoringTeam, score: this.score, spawns });
  }

  // ---------------------------------------------------------------- red

  broadcastSnapshot() {
    if (this.players.size === 0) return;
    const players = {};
    for (const p of this.players.values()) {
      players[p.id] = [
        +p.pos.x.toFixed(2),
        +p.pos.y.toFixed(2),
        +p.pos.z.toFixed(2),
        +p.yaw.toFixed(3),
        p.anim,
      ];
    }
    this.io.emit('snap', {
      t: Date.now(),
      b: [+this.ball.pos.x.toFixed(2), +this.ball.pos.y.toFixed(2), +this.ball.pos.z.toFixed(2)],
      o: this.ball.ownerId,
      p: players,
    });
  }
}
