/**
 * Sala única 4v4. Autoridad del servidor:
 *  - Física del balón (vuelo, rebotes, goles).
 *  - Posesión / conducción (el balón "pegado" a los pies).
 *  - Resolución de robos y faltas (cruzar pie / barrida).
 * Los jugadores son client-authoritative en su movimiento (con clamps),
 * el servidor retransmite snapshots a 20 Hz.
 */
import { FIELD, BALL, DRIBBLE, ACTIONS, NET, ANIM, PLAYER } from '../../shared/constants.js';
import { stepBall, collideBallWithArms, checkGoalCrossing, clampToPitch } from './physics.js';

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
      captureLockUntil: 0, // no puede capturar el balón (post-robo/barrida)
      handballCooldownUntil: 0,
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

    const ball = this.ball;
    const dx = ball.pos.x - p.pos.x;
    const dz = ball.pos.z - p.pos.z;
    const withinRange = dx * dx + dz * dz < ACTIONS.KICK_RANGE * ACTIONS.KICK_RANGE;
    if (ball.ownerId !== id && !withinRange) return;

    const dirYaw = Number.isFinite(data?.yaw) ? data.yaw : p.yaw;
    const power = Math.max(ACTIONS.KICK_MIN_POWER, Math.min(1, Number(data?.power) || 1));
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
    if (now < p.stunnedUntil) return;

    if (type === 'slide') {
      if (now < p.challengeCooldownUntil || p.challenge) return;
      p.challenge = { type, until: now + ACTIONS.SLIDE_DURATION_MS, resolved: false };
      p.challengeCooldownUntil = now + ACTIONS.SLIDE_COOLDOWN_MS;
      return;
    }

    // Cruzar pie: SIN cooldown — se puede spamear o cronometrar el toque.
    // Un nuevo clic reinicia la ventana activa.
    if (p.challenge?.type === 'slide') return; // no mezclar con una barrida en curso
    p.challenge = { type: 'extend', until: now + ACTIONS.EXTEND_DURATION_MS, resolved: false };
  }

  // ---------------------------------------------------------------- tick

  tick(dt) {
    const now = Date.now();
    const ball = this.ball;

    // Mano: DESACTIVADA por el momento (contacto del balón con el brazo,
    // hombro a mano). Método intacto en checkHandball() para reactivarla
    // más adelante — solo falta descomentar esta línea.
    // this.checkHandball(now);

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
      const goal = this.dribble(dt, now);
      if (goal !== 0) {
        this.onGoal(goal === 1 ? 0 : 1);
        return;
      }
    } else {
      const goal = stepBall(ball, dt);
      if (goal !== 0) {
        this.onGoal(goal === 1 ? 0 : 1);
        return;
      }
      // Sin colisión de cuerpo ni captura automática: el balón libre pasa
      // de largo (como entre las piernas) salvo que un jugador presione
      // cruzar pie / barrida (ver resolveChallenge) para recibirlo a propósito.
    }
  }

  /**
   * Contacto del balón con un brazo (entre hombro y mano): siempre es
   * falta, sin importar la animación en curso. Otorga el balón al rival
   * más cercano y aturde al infractor.
   */
  checkHandball(now) {
    for (const p of this.players.values()) {
      if (now < p.handballCooldownUntil) continue;
      if (!collideBallWithArms(this.ball, p)) continue;

      p.handballCooldownUntil = now + ACTIONS.HANDBALL_COOLDOWN_MS;
      p.stunnedUntil = now + ACTIONS.FOUL_STUN_MS;
      p.challenge = null;
      if (this.ball.ownerId === p.id) this.ball.ownerId = null;

      let nearest = null;
      let bestDistSq = Infinity;
      for (const rival of this.players.values()) {
        if (rival.team === p.team) continue;
        const dx = rival.pos.x - this.ball.pos.x;
        const dz = rival.pos.z - this.ball.pos.z;
        const d = dx * dx + dz * dz;
        if (d < bestDistSq) {
          bestDistSq = d;
          nearest = rival;
        }
      }
      if (nearest) {
        this.ball.ownerId = nearest.id;
        this.ball.capturedAt = now;
        this.io.emit('possession', { id: nearest.id });
      }
      this.io.emit('foul', {
        offender: p.id,
        victim: nearest ? nearest.id : null,
        type: 'handball',
        stunMs: ACTIONS.FOUL_STUN_MS,
      });
    }
  }

  /** El balón sigue el punto de control frente a los pies del dueño. Devuelve 0 | 1 | -1 (gol). */
  dribble(dt, now) {
    const owner = this.players.get(this.ball.ownerId);
    if (!owner || now < owner.stunnedUntil) {
      this.ball.ownerId = null;
      return 0;
    }
    const dist = !owner.moving
      ? DRIBBLE.DIST_IDLE
      : owner.sprinting
        ? DRIBBLE.DIST_SPRINT
        : DRIBBLE.DIST_JOG;
    const tx = owner.pos.x + Math.sin(owner.yaw) * dist;
    const tz = owner.pos.z + Math.cos(owner.yaw) * dist;

    // Primer toque suave: el seguimiento arranca lento tras capturar
    // para que el balón no se "teletransporte" al pie.
    const age = (now - (this.ball.capturedAt || 0)) / 1000;
    const ramp = Math.min(1, age / DRIBBLE.CAPTURE_RAMP_S);
    const rate = 4 + (DRIBBLE.FOLLOW_RATE - 4) * ramp;
    const k = 1 - Math.exp(-rate * dt);
    const ball = this.ball;
    ball.pos.x += (tx - ball.pos.x) * k;
    ball.pos.z += (tz - ball.pos.z) * k;
    ball.pos.y += (BALL.RADIUS - ball.pos.y) * k;
    ball.vel.x = ball.vel.z = ball.vel.y = 0;

    // Si el dueño saltó o quedó lejos (lag/teleport), suelta el balón.
    const dx = ball.pos.x - owner.pos.x;
    const dz = ball.pos.z - owner.pos.z;
    if (dx * dx + dz * dz > 6.25 || owner.pos.y > 0.6) {
      this.ball.ownerId = null;
      return 0;
    }

    // El balón conducido también puede cruzar la línea de gol o chocar
    // con bandas/fondos — antes no se detectaba mientras había dueño.
    const goal = checkGoalCrossing(ball);
    if (goal !== 0) return goal;
    clampToPitch(ball);
    return 0;
  }

  /**
   * Regla de cruzar pie / barrida:
   *  1) Si conecta con la PELOTA -> se la queda pegada (control/robo).
   *     - Cruzar pie: la pelota debe estar dentro del área de control
   *       circular alrededor del jugador (cualquier ángulo).
   *     - Barrida: el pie del lunge debe alcanzarla; también queda pegada.
   *  2) Si en cambio conecta con el RIVAL -> falta (en la barrida cuenta
   *     también el contacto de cuerpo, no solo el pie).
   */
  resolveChallenge(p, now) {
    const c = p.challenge;
    const reach = c.type === 'slide' ? ACTIONS.SLIDE_REACH : ACTIONS.EXTEND_REACH;
    const footX = p.pos.x + Math.sin(p.yaw) * reach;
    const footZ = p.pos.z + Math.cos(p.yaw) * reach;
    const ball = this.ball;

    // 1) ¿Conecta con la pelota?
    let touchesBall = false;
    if (ball.pos.y < 0.9 && ball.ownerId !== p.id) {
      if (c.type === 'extend') {
        // Área de control circular centrada en el jugador (360°).
        const dx = ball.pos.x - p.pos.x;
        const dz = ball.pos.z - p.pos.z;
        touchesBall = dx * dx + dz * dz < ACTIONS.CONTROL_AREA_RADIUS * ACTIONS.CONTROL_AREA_RADIUS;
      } else {
        const bdx = ball.pos.x - footX;
        const bdz = ball.pos.z - footZ;
        touchesBall = bdx * bdx + bdz * bdz < ACTIONS.STEAL_RADIUS * ACTIONS.STEAL_RADIUS;
      }
    }
    if (touchesBall) {
      const prevOwner = this.players.get(ball.ownerId);
      c.resolved = true;
      // El rival despojado no puede re-capturar al instante: el robo debe "quedarse".
      if (prevOwner) prevOwner.captureLockUntil = now + 1000;
      // Tanto cruzar pie como barrida dejan la pelota pegada a quien la tocó.
      ball.ownerId = p.id;
      ball.capturedAt = now;
      this.io.emit('possession', { id: p.id });
      this.io.emit('steal', {
        by: p.id,
        from: prevOwner ? prevOwner.id : null,
        type: c.type,
      });
      return;
    }

    // 2) ¿Conecta con un rival (sin haber tocado la pelota)?
    for (const rival of this.players.values()) {
      if (rival.team === p.team || rival.id === p.id) continue;
      if (rival.pos.y >= 0.6) continue;

      // Pie extendido / pie del lunge.
      const fdx = rival.pos.x - footX;
      const fdz = rival.pos.z - footZ;
      let contact = fdx * fdx + fdz * fdz < ACTIONS.FOUL_RADIUS * ACTIONS.FOUL_RADIUS;

      // En la barrida el CUERPO deslizándose también comete falta.
      if (!contact && c.type === 'slide') {
        const bdx = rival.pos.x - p.pos.x;
        const bdz = rival.pos.z - p.pos.z;
        contact = bdx * bdx + bdz * bdz < ACTIONS.SLIDE_BODY_FOUL_RADIUS * ACTIONS.SLIDE_BODY_FOUL_RADIUS;
      }
      if (!contact) continue;

      c.resolved = true;
      p.stunnedUntil = now + ACTIONS.FOUL_STUN_MS;
      p.challenge = null;
      // Si la víctima tenía el balón, lo conserva; si era libre, se lo queda.
      if (!this.ball.ownerId || this.ball.ownerId === p.id) {
        this.ball.ownerId = rival.id;
        this.ball.capturedAt = now;
        this.io.emit('possession', { id: rival.id });
      }
      this.io.emit('foul', {
        offender: p.id,
        victim: rival.id,
        type: c.type,
        stunMs: ACTIONS.FOUL_STUN_MS,
      });
      return;
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
