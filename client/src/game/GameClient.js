import * as THREE from 'three';
import { FIELD, PLAYER, ANIM, NET, BALL, DRIBBLE, ACTIONS } from '/shared/constants.js';
import { SteveCharacter } from '../entities/SteveCharacter.js';
import { Ball } from '../entities/Ball.js';
import { createPitch } from '../entities/Pitch.js';
import { CameraController } from '../core/CameraController.js';

const HALF_L = FIELD.LENGTH / 2;
const HALF_W = FIELD.WIDTH / 2;

/**
 * Orquestador del cliente:
 *  - Simulación local del jugador propio (predicción: movimiento, salto, stamina).
 *  - Interpolación de jugadores remotos y balón desde snapshots.
 *  - Predicción del balón cuando el jugador local tiene la posesión.
 */
export class GameClient {
  constructor({ scene, camera, input, net, hud }) {
    this.scene = scene;
    this.input = input;
    this.net = net;
    this.hud = hud;
    this.cameraCtrl = new CameraController(camera);

    this.myId = null;
    this.myTeam = 0;
    this.characters = new Map(); // id -> SteveCharacter
    this.nicknames = new Map();

    // Estado local (predicho).
    this.local = {
      pos: new THREE.Vector3(),
      velY: 0,
      yaw: 0,
      onGround: true,
      stamina: PLAYER.STAMINA_MAX,
      anim: ANIM.IDLE,
      sprinting: false,
      stunnedUntil: 0,
      actionUntil: 0, // fin de la pose de kick/extend
      slideUntil: 0,
      slideDir: 0,
      extendCdUntil: 0,
      slideCdUntil: 0,
    };
    this.ballOwnerId = null;
    this.sendAccumulator = 0;
    this.kickCharge = 0;

    this.scene.add(createPitch());
    this.ball = new Ball();
    this.scene.add(this.ball.mesh);

    // Línea de puntería del remate cargado (plana sobre el césped).
    const aimGeo = new THREE.PlaneGeometry(0.16, 1);
    aimGeo.rotateX(-Math.PI / 2);
    aimGeo.translate(0, 0, 0.5); // origen en el jugador, crece hacia +Z
    this.aimLine = new THREE.Mesh(
      aimGeo,
      new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.85 }),
    );
    this.aimLine.visible = false;
    this.scene.add(this.aimLine);

    this.bindNetEvents();
  }

  // ---------------------------------------------------------------- red

  bindNetEvents() {
    const net = this.net;

    net.on('joined', (data) => {
      this.myId = data.id;
      this.myTeam = data.team;
      this.local.pos.set(data.spawn.x, 0, data.spawn.z);
      this.hud.setScore(data.score);
      this.hud.show();
      for (const p of data.players) this.addCharacter(p);
    });

    net.on('playerJoined', (p) => {
      this.addCharacter(p);
      this.hud.message(`${p.nickname} se unió al equipo ${p.team === 0 ? 'rojo' : 'azul'}`);
    });

    net.on('playerLeft', (id) => {
      this.characters.get(id)?.dispose();
      this.characters.delete(id);
      this.nicknames.delete(id);
    });

    net.on('goal', (data) => {
      this.hud.setScore(data.score);
      this.hud.message(`¡GOOOL del equipo ${data.team === 0 ? 'ROJO' : 'AZUL'}!`, 'goal');
      const spawn = data.spawns[this.myId];
      if (spawn) this.local.pos.set(spawn.x, 0, spawn.z);
      this.local.velY = 0;
    });

    net.on('foul', (data) => {
      const offender = this.nicknames.get(data.offender) ?? '???';
      const victim = data.victim ? (this.nicknames.get(data.victim) ?? '???') : null;
      const label = data.type === 'handball' ? 'MANO' : 'FALTA';
      const msg = victim ? `¡${label} de ${offender} sobre ${victim}!` : `¡${label} de ${offender}!`;
      this.hud.message(msg, 'foul');
      if (data.offender === this.myId) {
        this.local.stunnedUntil = performance.now() + data.stunMs;
      }
    });

    net.on('steal', (data) => {
      if (data.by === this.myId) this.hud.message('¡Balón robado!');
      else if (data.from === this.myId) this.hud.message('Te robaron el balón');
    });

    net.on('possession', (data) => {
      this.ballOwnerId = data.id;
    });

    net.on('kicked', (data) => {
      if (data.id === this.ballOwnerId) this.ballOwnerId = null;
      const ch = this.characters.get(data.id);
      if (ch && data.id !== this.myId) ch.setAnim(ANIM.KICK);
    });
  }

  addCharacter(p) {
    if (this.characters.has(p.id)) return;
    const ch = new SteveCharacter(p.team, p.nickname);
    this.characters.set(p.id, ch);
    this.nicknames.set(p.id, p.nickname);
    this.scene.add(ch.group);
  }

  // ---------------------------------------------------------------- loop

  update(dt) {
    dt = Math.min(dt, 0.05);
    this.updateLocalPlayer(dt);
    this.updateRemotePlayers(dt);
    this.updateBall(dt);
    this.cameraCtrl.update(this.local.pos, dt);

    // Envío del estado a tasa fija.
    this.sendAccumulator += dt;
    if (this.myId && this.sendAccumulator >= 1 / NET.CLIENT_SEND_HZ) {
      this.sendAccumulator = 0;
      this.net.sendState(this.local.pos, this.local.yaw, this.local.anim, this.local.sprinting);
    }
  }

  updateLocalPlayer(dt) {
    if (!this.myId) return;
    const L = this.local;
    const now = performance.now();
    const stunned = now < L.stunnedUntil;
    const sliding = now < L.slideUntil;
    const inAction = now < L.actionUntil;

    // Cámara 360 (no rota al personaje).
    const md = this.input.consumeMouseDelta();
    this.cameraCtrl.applyMouseDelta(md.x, md.y);

    // ---- acciones
    if (!stunned && !sliding) {
      // Remate cargado (sin cooldown): mantener clic izq llena la barra
      // y muestra la línea de dirección según la cámara.
      if (this.input.kickHeld) {
        this.kickCharge = Math.min(1, this.kickCharge + (dt * 1000) / ACTIONS.KICK_CHARGE_TIME_MS);
      }
      if (this.input.consume('kickRelease')) {
        // Curva no lineal: un toque suelto empuja apenas el balón (~1 m);
        // recién cerca de la barra llena el remate se vuelve muy fuerte.
        const curved = Math.pow(this.kickCharge, ACTIONS.KICK_CURVE);
        const power = ACTIONS.KICK_MIN_POWER + (1 - ACTIONS.KICK_MIN_POWER) * curved;
        this.net.sendKick(this.cameraCtrl.yaw, power);
        L.anim = ANIM.KICK;
        L.actionUntil = now + 350;
        // Orientar la patada hacia la cámara.
        L.yaw = this.cameraCtrl.yaw;
        this.kickCharge = 0;
      }
      if (this.input.consume('extend') && now > L.extendCdUntil) {
        this.net.sendChallenge('extend');
        L.anim = ANIM.EXTEND;
        L.actionUntil = now + ACTIONS.EXTEND_DURATION_MS;
        L.extendCdUntil = now + ACTIONS.EXTEND_COOLDOWN_MS;
      }
      if (this.input.consume('slide') && now > L.slideCdUntil && L.onGround) {
        this.net.sendChallenge('slide');
        L.slideUntil = now + ACTIONS.SLIDE_DURATION_MS;
        L.slideCdUntil = now + ACTIONS.SLIDE_COOLDOWN_MS;
        L.slideDir = L.yaw;
      }
      if (this.input.consume('jump') && L.onGround) {
        L.velY = PLAYER.JUMP_SPEED;
        L.onGround = false;
      }
    } else {
      // Descartar acciones encoladas mientras está bloqueado.
      this.input.consume('kickRelease');
      this.input.consume('extend');
      this.input.consume('slide');
      this.input.consume('jump');
      this.kickCharge = 0;
    }

    // Línea de puntería + barra de poder mientras se carga el remate.
    const charging = this.input.kickHeld && !stunned && !sliding;
    this.aimLine.visible = charging;
    if (charging) {
      const len = 3.5 + this.kickCharge * 8.5;
      this.aimLine.scale.z = len;
      this.aimLine.position.set(L.pos.x, 0.03, L.pos.z);
      this.aimLine.rotation.y = this.cameraCtrl.yaw;
    }
    this.hud.setPower(charging ? this.kickCharge : null);

    // ---- movimiento
    let moveX = 0;
    let moveZ = 0;
    let speed = 0;
    let axisPresent = false;
    const shiftHeld = this.input.sprint;

    if (sliding) {
      // La barrida es un lunge sin control de dirección.
      const t = (L.slideUntil - now) / ACTIONS.SLIDE_DURATION_MS;
      speed = ACTIONS.SLIDE_SPEED * t;
      moveX = Math.sin(L.slideDir);
      moveZ = Math.cos(L.slideDir);
    } else if (!stunned) {
      const axis = this.input.moveAxis;
      axisPresent = axis.x !== 0 || axis.z !== 0;

      // Solo puede sprintar si sigue habiendo stamina por ENCIMA del umbral.
      // Al agotarse, vuelve a trote — y no puede re-sprintar hasta soltar
      // Shift (evita el parpadeo trote/sprint al rozar el umbral).
      const wantsSprint = shiftHeld && axisPresent && L.stamina > PLAYER.STAMINA_MIN_TO_SPRINT;
      L.sprinting = wantsSprint;

      if (axisPresent) {
        // WASD relativo al yaw de la cámara.
        // forward = (sin, cos); right en pantalla = (-cos, sin).
        const camYaw = this.cameraCtrl.yaw;
        const len = Math.hypot(axis.x, axis.z);
        const nx = axis.x / len;
        const nz = axis.z / len;
        moveX = -nx * Math.cos(camYaw) + nz * Math.sin(camYaw);
        moveZ = nx * Math.sin(camYaw) + nz * Math.cos(camYaw);
        speed = wantsSprint ? PLAYER.SPRINT_SPEED : PLAYER.WALK_SPEED;

        // Estilo strafe: el cuerpo mantiene el frente hacia la cámara;
        // moverse al costado es un desplazamiento lateral, no un giro.
        L.yaw = lerpAngle(L.yaw, camYaw, 1 - Math.exp(-14 * dt));
      }
    }

    // Stamina: drena solo al sprintar de verdad. NO recarga mientras Shift
    // siga presionado (aunque ya no se pueda sprintar) — hay que soltarlo.
    // Parado del todo (sin ejes ni Shift) recarga más rápido.
    if (L.sprinting) {
      L.stamina = Math.max(0, L.stamina - PLAYER.STAMINA_DRAIN_PER_S * dt);
    } else if (!shiftHeld && !sliding && !stunned) {
      const idleBonus = axisPresent ? 1 : PLAYER.STAMINA_REGEN_IDLE_MULT;
      L.stamina = Math.min(PLAYER.STAMINA_MAX, L.stamina + PLAYER.STAMINA_REGEN_PER_S * idleBonus * dt);
    }
    this.hud.setStamina(L.stamina / PLAYER.STAMINA_MAX);

    L.pos.x += moveX * speed * dt;
    L.pos.z += moveZ * speed * dt;
    L.pos.x = THREE.MathUtils.clamp(L.pos.x, -HALF_L - 0.5, HALF_L + 0.5);
    L.pos.z = THREE.MathUtils.clamp(L.pos.z, -HALF_W + 0.4, HALF_W - 0.4);

    // Salto / gravedad.
    if (!L.onGround) {
      L.velY -= PLAYER.GRAVITY * dt;
      L.pos.y += L.velY * dt;
      if (L.pos.y <= 0) {
        L.pos.y = 0;
        L.velY = 0;
        L.onGround = true;
      }
    }

    // ---- estado de animación
    if (stunned) L.anim = ANIM.STUNNED;
    else if (sliding) L.anim = ANIM.SLIDE;
    else if (inAction && (L.anim === ANIM.KICK || L.anim === ANIM.EXTEND)) {
      /* mantener pose de acción */
    } else if (!L.onGround) L.anim = ANIM.JUMP;
    else if (speed > 0) L.anim = L.sprinting ? ANIM.SPRINT : ANIM.JOG;
    else L.anim = ANIM.IDLE;

    // Aplicar al mesh propio.
    const ch = this.characters.get(this.myId);
    if (ch) {
      ch.group.position.copy(L.pos);
      ch.group.rotation.y = L.yaw;
      ch.setAnim(L.anim);
      ch.update(dt, speed);
    }
  }

  updateRemotePlayers(dt) {
    const pair = this.net.getInterpolationPair();
    if (!pair) return;
    const { a, b, alpha } = pair;

    for (const [id, ch] of this.characters) {
      if (id === this.myId) continue;
      const sa = a.p[id];
      const sb = b.p[id] ?? sa;
      if (!sa) continue;

      const x = sa[0] + (sb[0] - sa[0]) * alpha;
      const y = sa[1] + (sb[1] - sa[1]) * alpha;
      const z = sa[2] + (sb[2] - sa[2]) * alpha;
      const speed = Math.hypot(sb[0] - sa[0], sb[2] - sa[2]) / Math.max(0.001, (b.t - a.t) / 1000);

      ch.group.position.set(x, y, z);
      ch.group.rotation.y = lerpAngle(sa[3], sb[3], alpha);
      ch.setAnim(sb[4]);
      ch.update(dt, speed);
    }
  }

  updateBall(dt) {
    const pair = this.net.getInterpolationPair();
    if (pair) this.ballOwnerId = pair.b.o;

    if (this.ballOwnerId === this.myId) {
      // Predicción local del control: el balón se "pega" a los pies y se
      // separa más al trotar y aún más al sprintar (control realista).
      const L = this.local;
      const dist = L.anim === ANIM.SPRINT ? DRIBBLE.DIST_SPRINT : L.anim === ANIM.JOG ? DRIBBLE.DIST_JOG : DRIBBLE.DIST_IDLE;
      const tx = L.pos.x + Math.sin(L.yaw) * dist;
      const tz = L.pos.z + Math.cos(L.yaw) * dist;
      const k = 1 - Math.exp(-DRIBBLE.FOLLOW_RATE * dt);
      this.ball.mesh.position.x += (tx - this.ball.mesh.position.x) * k;
      this.ball.mesh.position.z += (tz - this.ball.mesh.position.z) * k;
      this.ball.mesh.position.y += (BALL.RADIUS - this.ball.mesh.position.y) * k;
    } else if (pair) {
      const { a, b, alpha } = pair;
      this.ball.mesh.position.set(
        a.b[0] + (b.b[0] - a.b[0]) * alpha,
        a.b[1] + (b.b[1] - a.b[1]) * alpha,
        a.b[2] + (b.b[2] - a.b[2]) * alpha,
      );
    }
    this.ball.updateRoll(dt);
  }
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
