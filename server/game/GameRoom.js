/**
 * Sala única 4v4. Autoridad del servidor:
 *  - Física del balón (vuelo, rebotes, goles).
 *  - Posesión / conducción (el balón "pegado" a los pies).
 *  - Resolución de robos y faltas (cruzar pie / barrida).
 * Los jugadores son client-authoritative en su movimiento (con clamps),
 * el servidor retransmite snapshots a 20 Hz.
 */
import { FIELD, CAMERA, BALL, DRIBBLE, ACTIONS, NET, ANIM, PLAYER } from '../../shared/constants.js';
import {
  stepBall,
  collideBallWithArms,
  collideBallWithPlayer,
  collideBallWithSlidingBody,
  collideBallWithLowDiveBody,
  collideBallWithAirborneBody,
  checkGoalCrossing,
  clampToPitch,
  clampPlayerToPitch,
  resolvePlayerCollision,
} from './physics.js';

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
    this.ball = { pos: { x: 0, y: BALL.RADIUS, z: 0 }, vel: { x: 0, y: 0, z: 0 }, ownerId: null, caught: false };
    this.score = [0, 0];
    this.kickoffFreezeUntil = 0;

    const dt = 1 / NET.SERVER_TICK_HZ;
    setInterval(() => this.tick(dt), 1000 / NET.SERVER_TICK_HZ);
    setInterval(() => this.broadcastSnapshot(), 1000 / NET.SNAPSHOT_HZ);
  }

  // ---------------------------------------------------------------- lobby

  addPlayer(socket, nickname, skin, position) {
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
      skin: skin || 'steve',
      position: position === 'GK' ? 'GK' : 'FIELD', // arquero: habilita el clavado lateral
      team,
      pos: { x: spawn.x, y: 0, z: spawn.z },
      vel: { x: 0, z: 0 }, // velocidad real estimada (no visible al jugador), usada en física de barrida/salto
      lastStateAt: 0,
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
      position: player.position,
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
    return { id: p.id, nickname: p.nickname, team: p.team, skin: p.skin, position: p.position };
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

    const now = Date.now();
    const prevX = p.pos.x;
    const prevZ = p.pos.z;

    // Clamps anti-trampa: los jugadores viven DENTRO de la cancha (así
    // nadie puede rodear el arco y meter el balón "desde afuera").
    p.pos.x = x;
    p.pos.y = Math.max(0, Math.min(4, y));
    p.pos.z = z;
    clampPlayerToPitch(p);
    p.yaw = yaw;
    p.anim = anim | 0;
    p.sprinting = !!sprinting;
    p.moving = p.anim === ANIM.JOG || p.anim === ANIM.SPRINT;

    // Velocidad real estimada por diferencia de posición entre estados
    // (nunca se le muestra al jugador; solo la usa la física, p.ej. la
    // fuerza de salida del balón al barrerse). Suavizada para no saltar
    // con la irregularidad de la red, y descartada si el salto es un
    // teleport/lag spike en vez de movimiento real.
    const dtMs = now - p.lastStateAt;
    if (p.lastStateAt > 0 && dtMs > 0 && dtMs < 400) {
      const dt = dtMs / 1000;
      const rawVx = (p.pos.x - prevX) / dt;
      const rawVz = (p.pos.z - prevZ) / dt;
      if (Math.hypot(rawVx, rawVz) < 25) {
        const k = 0.5;
        p.vel.x += (rawVx - p.vel.x) * k;
        p.vel.z += (rawVz - p.vel.z) * k;
      }
    }
    p.lastStateAt = now;
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
    const charge = Math.max(0, Math.min(1, Number(data?.power) || 0));

    // Origen del disparo: el balón sale SIEMPRE desde adelante del pateador,
    // en su última posición conocida por el cliente (con el estado del
    // servidor el balón quedaba ~2 pasos atrás al patear en sprint, por el
    // lag entre cliente y snapshot). Validado contra teleports (máx. 3 m).
    if (ball.ownerId === id) {
      let kx = p.pos.x;
      let kz = p.pos.z;
      if (Array.isArray(data?.pos) && data.pos.length === 2 && data.pos.every(Number.isFinite)) {
        const ddx = data.pos[0] - p.pos.x;
        const ddz = data.pos[1] - p.pos.z;
        if (ddx * ddx + ddz * ddz < 9) {
          kx = data.pos[0];
          kz = data.pos[1];
        }
      }
      ball.pos.x = kx + Math.sin(dirYaw) * DRIBBLE.DIST_JOG;
      ball.pos.z = kz + Math.cos(dirYaw) * DRIBBLE.DIST_JOG;
      ball.pos.y = BALL.RADIUS;
      clampToPitch(ball);
    }

    // Potencia por tramos, MUY adelantada: con la barra recién empezada
    // (KICK_PIVOT_CHARGE, ~20%) el remate ya "se siente" fuerte de verdad
    // (KICK_PIVOT_SPEED); de ahí a la barra llena sigue creciendo hasta
    // el máximo (KICK_POWER). Antes hacía falta cargar ~80% para sentir
    // algo — ahora ese mismo punch se siente a los ~20%.
    let speed;
    if (charge <= ACTIONS.KICK_PIVOT_CHARGE) {
      const t = charge / ACTIONS.KICK_PIVOT_CHARGE;
      speed = ACTIONS.KICK_MIN_SPEED + (ACTIONS.KICK_PIVOT_SPEED - ACTIONS.KICK_MIN_SPEED) * Math.pow(t, ACTIONS.KICK_LOW_CURVE);
    } else {
      const t = (charge - ACTIONS.KICK_PIVOT_CHARGE) / (1 - ACTIONS.KICK_PIVOT_CHARGE);
      speed = ACTIONS.KICK_PIVOT_SPEED + (ACTIONS.KICK_POWER - ACTIONS.KICK_PIVOT_SPEED) * Math.pow(t, ACTIONS.KICK_CURVE);
    }
    // Elevación DESACOPLADA de la potencia: la maneja sobre todo hacia
    // dónde mira verticalmente la cámara (pitch), no cuánto se cargó la
    // barra — así un toque mínimo apuntando bien arriba igual levanta el
    // balón lo suficiente para un centro/globo corto y controlable, en vez
    // de necesitar rematar fuerte para poder levantarla (lo que solo
    // permitía pelotazos lejanos con altura, nunca centros cortos).
    const pitch = Number.isFinite(data?.pitch)
      ? Math.max(CAMERA.PITCH_MIN, Math.min(CAMERA.PITCH_MAX, data.pitch))
      : 0.35;
    const pitchNorm = 1 - (pitch - CAMERA.PITCH_MIN) / (CAMERA.PITCH_MAX - CAMERA.PITCH_MIN); // 0 piso, 1 cielo
    const liftY =
      ACTIONS.KICK_LIFT_BASE + pitchNorm * ACTIONS.KICK_LIFT_PITCH_MAX + charge * ACTIONS.KICK_LIFT_CHARGE_BONUS;
    p.lastKickAt = now;
    ball.ownerId = null;
    ball.caught = false;
    ball.vel.x = Math.sin(dirYaw) * speed;
    ball.vel.z = Math.cos(dirYaw) * speed;
    ball.vel.y = liftY;
    this.io.emit('kicked', { id });
  }

  /** Cruzar pie (extend), barrida (slide) o vuelo bajo (lowdive, solo GK). El robo/falta se evalúa en el tick. */
  onChallenge(id, data) {
    const p = this.players.get(id);
    if (!p) return;
    const now = Date.now();
    const type = data?.type === 'slide' ? 'slide' : data?.type === 'lowdive' ? 'lowdive' : 'extend';
    if (now < p.stunnedUntil) return;
    // Ninguna de las tres tiene sentido con el balón ya en tus propios pies.
    if (this.ball.ownerId === id) return;

    // SIN cooldown salvo la barrida recta (única acción que lo tiene, a
    // pedido explícito): el vuelo bajo solo no puede solaparse con otra
    // acción en curso, sin castigo extra después de terminar.
    if (type === 'slide') {
      if (now < p.challengeCooldownUntil || p.challenge) return;
      p.challenge = { type, until: now + ACTIONS.SLIDE_DURATION_MS, resolved: false };
      p.challengeCooldownUntil = now + ACTIONS.SLIDE_COOLDOWN_MS;
      return;
    }
    if (type === 'lowdive') {
      if (p.position !== 'GK' || p.challenge) return;
      p.challenge = { type, until: now + ACTIONS.LOW_DIVE_DURATION_MS, resolved: false, side: Number(data?.side) >= 0 ? 1 : -1 };
      return;
    }

    // Cruzar pie: SIN cooldown — se puede spamear o cronometrar el toque.
    // Un nuevo clic reinicia la ventana activa.
    if (p.challenge?.type === 'slide' || p.challenge?.type === 'lowdive') return; // no mezclar con un lunge en curso
    p.challenge = { type: 'extend', until: now + ACTIONS.EXTEND_DURATION_MS, resolved: false };
  }

  /** ¿`p.pos` cae dentro del área de meta que defiende su propio equipo? */
  isInOwnPenaltyArea(p) {
    if (Math.abs(p.pos.z) > FIELD.PENALTY_WIDTH / 2) return false;
    return p.team === 0 ? p.pos.x < -HALF_L + FIELD.PENALTY_DEPTH : p.pos.x > HALF_L - FIELD.PENALTY_DEPTH;
  }

  /**
   * El arquero `p` ataja el balón (libre) con las manos: pasa a ser el
   * dueño con `caught = true` (ver `dribble()`, lo sostiene cerca del
   * pecho en vez de a los pies). Se llama automáticamente cuando el balón
   * TOCA su cuerpo mientras vuela (clavado alto o vuelo bajo) dentro de
   * SU área de meta — no hace falta ningún botón (ver `tick()`).
   */
  catchBall(p, now) {
    const prevOwner = this.players.get(this.ball.ownerId);
    if (prevOwner) prevOwner.captureLockUntil = now + 1000;
    this.ball.ownerId = p.id;
    this.ball.caught = true;
    this.ball.capturedAt = now;
    this.io.emit('possession', { id: p.id });
    this.io.emit('caught', { id: p.id });
  }

  /**
   * Colisión cuerpo a cuerpo entre todos los jugadores (círculo-círculo,
   * precisa): nadie se atraviesa. Se excluye a quien está en el aire
   * (salto) y a quien está barriéndose — ese contacto lo resuelve el
   * sistema de faltas (resolveChallenge), no un empujón genérico.
   */
  resolvePlayerCollisions(now) {
    const isLunging = (p) =>
      (p.challenge?.type === 'slide' || p.challenge?.type === 'lowdive') && now < p.challenge.until;
    const list = [...this.players.values()];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.pos.y > 0.5 || isLunging(a)) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.pos.y > 0.5 || isLunging(b)) continue;
        if (resolvePlayerCollision(a, b, PLAYER.RADIUS)) {
          clampPlayerToPitch(a);
          clampPlayerToPitch(b);
        }
      }
    }
  }

  // ---------------------------------------------------------------- tick

  tick(dt) {
    const now = Date.now();
    const ball = this.ball;

    // Los jugadores no se atraviesan entre sí (círculo-círculo, precisa).
    this.resolvePlayerCollisions(now);

    // Mano: DESACTIVADA por el momento (contacto del balón con el brazo,
    // hombro a mano). Método intacto en checkHandball() para reactivarla
    // más adelante — solo falta descomentar esta línea.
    // this.checkHandball(now);

    // Cruzar pie: se resuelve para TODOS los jugadores a la vez (no de a
    // uno) — así, si dos rivales llegan al balón en el mismo instante y
    // ambos son elegibles, se puede definir 50/50 en vez de que gane
    // siempre quien se procesó primero.
    this.resolveExtends(now);

    // Barrida: tiene su propia lógica de robo/despoje + falta (con
    // oclusión), se resuelve individualmente.
    for (const p of this.players.values()) {
      if (p.challenge?.type === 'slide' && !p.challenge.resolved) {
        this.resolveSlideChallenge(p, now);
      }
    }

    // Limpieza de desafíos vencidos (ambos tipos).
    for (const p of this.players.values()) {
      if (p.challenge && now > p.challenge.until) p.challenge = null;
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
      // cruzar pie / barrida (ver resolve*Challenge) para recibirlo a
      // propósito. EXCEPCIONES, siempre automáticas (sin clic):
      //  - un cuerpo BARRIÉNDOSE es sólido (rebota de frente/costado/arriba).
      //  - un cuerpo en VUELO BAJO o CLAVADO (arquero) es sólido hacia el
      //    costado/aire — y si lo TOCA dentro de SU área de meta, en vez de
      //    rebotarlo lo ataja con las manos (catchBall), sin apretar nada.
      //  - el ARQUERO de pie también es sólido (colisión automática de
      //    cuerpo, sin necesidad de cruzar pie) — pero eso solo bloquea o
      //    rebota, nunca ataja (atajar requiere estar en pleno vuelo).
      for (const p of this.players.values()) {
        if (ball.ownerId) break; // ya lo atajaron este mismo tick
        if (p.challenge?.type === 'slide') {
          collideBallWithSlidingBody(ball, p);
        } else if (p.challenge?.type === 'lowdive') {
          const hit = collideBallWithLowDiveBody(ball, p, p.challenge.side || 1);
          if (hit && this.isInOwnPenaltyArea(p)) this.catchBall(p, now);
        } else if (p.pos.y > PLAYER.AIRBORNE_COLLISION_MIN_Y) {
          const hit = collideBallWithAirborneBody(ball, p);
          if (hit && p.position === 'GK' && p.anim === ANIM.DIVE && this.isInOwnPenaltyArea(p)) {
            this.catchBall(p, now);
          }
        } else if (p.position === 'GK') {
          collideBallWithPlayer(ball, p);
        }
      }
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
      this.ball.caught = false;

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
        this.ball.caught = false;
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

  /** El balón sigue el punto de control frente a los pies del dueño (o las manos, si lo atajó). Devuelve 0 | 1 | -1 (gol). */
  dribble(dt, now) {
    const owner = this.players.get(this.ball.ownerId);
    if (!owner || now < owner.stunnedUntil) {
      this.ball.ownerId = null;
      this.ball.caught = false;
      return 0;
    }
    const ball = this.ball;
    let tx;
    let tz;
    let ty;
    if (ball.caught) {
      // Arquero con el balón atajado: fijo cerca del pecho, no a los pies.
      tx = owner.pos.x + Math.sin(owner.yaw) * 0.35;
      tz = owner.pos.z + Math.cos(owner.yaw) * 0.35;
      ty = owner.pos.y + 1.15;
    } else {
      const dist = !owner.moving
        ? DRIBBLE.DIST_IDLE
        : owner.sprinting
          ? DRIBBLE.DIST_SPRINT
          : DRIBBLE.DIST_JOG;
      tx = owner.pos.x + Math.sin(owner.yaw) * dist;
      tz = owner.pos.z + Math.cos(owner.yaw) * dist;
      ty = BALL.RADIUS;
    }

    // Primer toque suave: el seguimiento arranca lento tras capturar
    // para que el balón no se "teletransporte" al pie.
    const age = (now - (this.ball.capturedAt || 0)) / 1000;
    const ramp = Math.min(1, age / DRIBBLE.CAPTURE_RAMP_S);
    const rate = 4 + (DRIBBLE.FOLLOW_RATE - 4) * ramp;
    const k = 1 - Math.exp(-rate * dt);
    ball.pos.x += (tx - ball.pos.x) * k;
    ball.pos.z += (tz - ball.pos.z) * k;
    ball.pos.y += (ty - ball.pos.y) * k;
    ball.vel.x = ball.vel.z = ball.vel.y = 0;

    // Si el dueño saltó o quedó lejos (lag/teleport), suelta el balón —
    // salvo que lo tenga atajado en las manos: recién aterrizando de un
    // clavado sigue "en el aire" un instante y no debe soltarlo por eso.
    const dx = ball.pos.x - owner.pos.x;
    const dz = ball.pos.z - owner.pos.z;
    if (!ball.caught && (dx * dx + dz * dz > 6.25 || owner.pos.y > 0.6)) {
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
   * Cruzar pie: ¿esté jugador puede tocar la pelota ahora mismo? Cilindro
   * de control de pies a cabeza, centrado en el jugador (360°) — cubre
   * también los balones que llegan "volando" bajo.
   */
  checkExtendEligibility(p) {
    const ball = this.ball;
    if (ball.ownerId === p.id) return false;
    const dx = ball.pos.x - p.pos.x;
    const dz = ball.pos.z - p.pos.z;
    const inRadius = dx * dx + dz * dz < ACTIONS.CONTROL_AREA_RADIUS * ACTIONS.CONTROL_AREA_RADIUS;
    const inHeight = ball.pos.y < ACTIONS.CONTROL_AREA_HEIGHT;
    return inRadius && inHeight;
  }

  /**
   * Cruzar pie: SIN falta — si no toca la pelota, no pasa nada. Se
   * resuelve para todos los jugadores a la vez (no de a uno): si dos
   * rivales están en igualdad de condiciones en el mismo instante
   * (ambos elegibles), se define 50/50 en vez de que gane siempre quien
   * se procesó primero.
   */
  resolveExtends(now) {
    const contenders = [];
    for (const p of this.players.values()) {
      const c = p.challenge;
      if (c?.type !== 'extend' || c.resolved || now > c.until) continue;
      if (this.checkExtendEligibility(p)) contenders.push(p);
    }
    if (contenders.length === 0) return;

    const winner =
      contenders.length === 1 ? contenders[0] : contenders[Math.floor(Math.random() * contenders.length)];
    for (const p of contenders) p.challenge.resolved = true;

    const ball = this.ball;
    const prevOwner = this.players.get(ball.ownerId);
    if (prevOwner) prevOwner.captureLockUntil = now + 1000;
    ball.ownerId = winner.id;
    ball.caught = false;
    ball.capturedAt = now;
    this.io.emit('possession', { id: winner.id });
    this.io.emit('steal', { by: winner.id, from: prevOwner ? prevOwner.id : null, type: 'extend' });
  }

  /**
   * Barrida — SIEMPRE gana lo que el pie/cuerpo alcanza PRIMERO (la menor
   * distancia real), nunca "la pelota por default". Comparar distancias
   * hace que un rival en el medio directamente bloquee el alcance a la
   * pelota, con resultado consistente siempre.
   *
   *  - Pelota alcanzada (controlada por un rival): NO controla — solo
   *    DESPOJA, el balón queda suelto con un empujón corto.
   *  - Rival alcanzado (pie del lunge o el cuerpo entero deslizándose):
   *    falta — el infractor queda tendido y luego se levanta; la víctima
   *    cae empujada en la dirección del golpe (velocidad del infractor
   *    si venía corriendo, si no la línea infractor -> víctima).
   */
  resolveSlideChallenge(p, now) {
    const c = p.challenge;
    const footX = p.pos.x + Math.sin(p.yaw) * ACTIONS.SLIDE_REACH;
    const footZ = p.pos.z + Math.cos(p.yaw) * ACTIONS.SLIDE_REACH;
    const ball = this.ball;

    // Distancia² de la pelota al pie del lunge, solo si es alcanzable
    // (únicamente contra un balón CONTROLADO por un rival — el balón
    // libre rebota contra el cuerpo en el tick, ver collideBallWithSlidingBody).
    let ballDistSq = Infinity;
    if (ball.ownerId && ball.ownerId !== p.id && ball.pos.y < 0.9) {
      const bdx = ball.pos.x - footX;
      const bdz = ball.pos.z - footZ;
      const d = bdx * bdx + bdz * bdz;
      if (d < ACTIONS.STEAL_RADIUS * ACTIONS.STEAL_RADIUS) ballDistSq = d;
    }

    // Rival más cercano al pie/cuerpo, si hay contacto real.
    let bestRival = null;
    let bestRivalDistSq = Infinity;
    for (const rival of this.players.values()) {
      if (rival.team === p.team || rival.id === p.id || rival.pos.y >= 0.6) continue;

      const fdx = rival.pos.x - footX;
      const fdz = rival.pos.z - footZ;
      let d = fdx * fdx + fdz * fdz;
      let within = d < ACTIONS.FOUL_RADIUS * ACTIONS.FOUL_RADIUS;

      // El CUERPO deslizándose también comete falta, no solo el pie del
      // lunge — se usa el contacto más cercano de los dos.
      const bdx = rival.pos.x - p.pos.x;
      const bdz = rival.pos.z - p.pos.z;
      const bd = bdx * bdx + bdz * bdz;
      if (bd < ACTIONS.SLIDE_BODY_FOUL_RADIUS * ACTIONS.SLIDE_BODY_FOUL_RADIUS && bd < d) {
        d = bd;
        within = true;
      }
      if (within && d < bestRivalDistSq) {
        bestRivalDistSq = d;
        bestRival = rival;
      }
    }

    if (ballDistSq === Infinity && bestRival === null) return; // nada al alcance todavía

    // Oclusión: si el cuerpo del rival alcanzado está sobre la línea recta
    // entre el jugador y la pelota, bloquea el camino — el pie no puede
    // "saltarlo" para tocarla, sin importar qué distancia dé más corta.
    // (Sin esto, con el rival parado y la pelota a la distancia de reposo
    // de sus pies, el punto de alcance del pie puede caer justo a mitad de
    // camino entre ambos y empatar las dos distancias, dando resultados
    // inconsistentes entre intentos casi idénticos.)
    let occluded = false;
    if (bestRival && ballDistSq !== Infinity) {
      const toBallX = ball.pos.x - p.pos.x;
      const toBallZ = ball.pos.z - p.pos.z;
      const lenSq = toBallX * toBallX + toBallZ * toBallZ;
      if (lenSq > 1e-6) {
        const t = ((bestRival.pos.x - p.pos.x) * toBallX + (bestRival.pos.z - p.pos.z) * toBallZ) / lenSq;
        if (t > -0.1 && t < 1.1) {
          const cx = p.pos.x + toBallX * Math.max(0, Math.min(1, t));
          const cz = p.pos.z + toBallZ * Math.max(0, Math.min(1, t));
          const dx = bestRival.pos.x - cx;
          const dz = bestRival.pos.z - cz;
          occluded = dx * dx + dz * dz < 0.49; // corredor de ~0.7 m (radios de cuerpo + pelota)
        }
      }
    }

    // Gana lo que está MÁS CERCA del pie/cuerpo — salvo que el rival
    // alcanzado ocluya directamente el camino a la pelota, en cuyo caso
    // la falta gana siempre.
    if (!occluded && ballDistSq <= bestRivalDistSq) {
      const prevOwner = this.players.get(ball.ownerId);
      c.resolved = true;
      // El rival despojado no puede re-capturar al instante: el despojo debe "quedarse".
      if (prevOwner) prevOwner.captureLockUntil = now + 1000;
      // La barrida solo quita la posesión: balón suelto, empujón corto.
      ball.ownerId = null;
      ball.caught = false;
      ball.vel.x = Math.sin(p.yaw) * 3.5;
      ball.vel.z = Math.cos(p.yaw) * 3.5;
      ball.vel.y = 0.8;
      p.captureLockUntil = now + 400;
      this.io.emit('steal', {
        by: p.id,
        from: prevOwner ? prevOwner.id : null,
        type: 'slide',
      });
      return;
    }

    // Falta.
    const rival = bestRival;
    c.resolved = true;
    p.stunnedUntil = now + ACTIONS.FOUL_STUN_MS;
    p.challenge = null;
    // Si la víctima tenía el balón, lo conserva; si era libre, se lo queda.
    if (!this.ball.ownerId || this.ball.ownerId === p.id) {
      this.ball.ownerId = rival.id;
      this.ball.caught = false;
      this.ball.capturedAt = now;
      this.io.emit('possession', { id: rival.id });
    }

    // Dirección del golpe para el empujón de la víctima: la del
    // movimiento del infractor si venía corriendo, si no la línea
    // infractor -> víctima.
    const offenderSpeed = Math.hypot(p.vel.x, p.vel.z);
    let dirX;
    let dirZ;
    if (offenderSpeed > 0.5) {
      dirX = p.vel.x / offenderSpeed;
      dirZ = p.vel.z / offenderSpeed;
    } else {
      const dx = rival.pos.x - p.pos.x;
      const dz = rival.pos.z - p.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      dirX = dx / d;
      dirZ = dz / d;
    }

    this.io.emit('foul', {
      offender: p.id,
      victim: rival.id,
      type: 'slide',
      stunMs: ACTIONS.FOUL_STUN_MS,
      dir: [dirX, dirZ],
      speed: offenderSpeed,
    });
  }

  onGoal(scoringTeam) {
    this.score[scoringTeam]++;
    this.ball.ownerId = null;
    this.ball.caught = false;
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
