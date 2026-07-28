import * as THREE from 'three';
import { FIELD, CAMERA, PLAYER, ANIM, NET, BALL, DRIBBLE, ACTIONS } from '/shared/constants.js';
import { SteveCharacter } from '../entities/SteveCharacter.js';
import { Ball } from '../entities/Ball.js';
import { createPitch } from '../entities/Pitch.js';
import { CameraController } from '../core/CameraController.js';
import { SoundManager } from '../audio/SoundManager.js';

const HALF_L = FIELD.LENGTH / 2;
const HALF_W = FIELD.WIDTH / 2;
const AIM_TRAJECTORY_POINTS = 26;
const AIM_TRAJECTORY_STEP = 0.045; // s por muestra del recorrido previsto

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
    this.myPosition = 'FIELD'; // 'GK' habilita el clavado lateral
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
      slideCdUntil: 0,
      curSpeed: 0, // velocidad real (con inercia); nunca se muestra en el HUD
      groundUntil: 0, // infractor en falta de barrida: tendido antes de pararse
      knockedUntil: 0, // víctima de una falta: cayendo por el empujón
      knockDirX: 0,
      knockDirZ: 0,
      diving: false, // arquero: clavado lateral en el aire
      diveDirX: 0,
      diveDirZ: 0,
      diveGroundUntil: 0, // arquero: tendido de costado tras cualquier clavada (alta o baja), antes de levantarse
      lowDiveUntil: 0, // arquero: vuelo bajo (lateral, pegado al piso)
      lowDiveDirX: 0,
      lowDiveDirZ: 0,
      wasLowDiving: false, // detecta el instante en que termina el vuelo bajo, para arrancar la recuperación
      holding: false, // arquero: balón atajado en las manos
      velX: 0, // velocidad real (con dirección) del frame anterior — para heredarla al patear
      velZ: 0,
      justKicked: false, // flanco: fuerza el reinicio de la animación de patada aunque siga en ANIM.KICK
    };
    this.ballOwnerId = null;
    // Último momento en que un evento INSTANTÁNEO (possession/kicked) puso
    // this.ballOwnerId — ver updateBall(): el snapshot interpolado llega
    // ~INTERP_DELAY_MS más tarde, así que no debe pisar un cambio de dueño
    // recién confirmado con su propio valor todavía viejo.
    this.ballOwnerSetAt = 0;
    this.sendAccumulator = 0;
    this.kickCharge = 0;
    this.sound = new SoundManager();

    this.scene.add(createPitch());
    this.ball = new Ball();
    this.scene.add(this.ball.mesh);

    // Recorrido previsto del remate cargado: una curva que muestra el
    // arco real que hará el balón (misma física que el servidor), no solo
    // la dirección — se recalcula en vivo mientras se carga (ver
    // updateAimTrajectory), reaccionando tanto a la potencia como a hacia
    // dónde apunta la cámara verticalmente.
    const aimGeo = new THREE.BufferGeometry();
    aimGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(AIM_TRAJECTORY_POINTS * 3), 3));
    this.aimLine = new THREE.Line(aimGeo, new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.9 }));
    this.aimLine.visible = false;
    this.aimLine.frustumCulled = false;
    this.scene.add(this.aimLine);

    // Círculo en la base del jugador local: indica el área donde cruzar pie
    // puede controlar/robar el balón (el personaje cabe dentro de él).
    const ringGeo = new THREE.RingGeometry(ACTIONS.CONTROL_AREA_RADIUS - 0.06, ACTIONS.CONTROL_AREA_RADIUS, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.controlRing = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }),
    );
    this.controlRing.visible = false;
    this.scene.add(this.controlRing);

    // Depuración de la asistencia de atajada (arquero): esfera roja
    // translúcida que muestra PLAYER.DIVE_CATCH_SPHERE_RADIUS — SOLO para
    // programar/ajustar (ver GameRoom.checkDiveCatchSphere), nunca visible
    // en el juego normal (gateada por window.SOKKAIO_DEBUG, ?debug=1).
    if (window.SOKKAIO_DEBUG) {
      const sphereGeo = new THREE.SphereGeometry(PLAYER.DIVE_CATCH_SPHERE_RADIUS, 16, 12);
      this.debugCatchSphere = new THREE.Mesh(
        sphereGeo,
        new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.25, depthWrite: false }),
      );
      this.debugCatchSphere.visible = false;
      this.scene.add(this.debugCatchSphere);
      this._debugSphereBox = new THREE.Box3();
    }

    this.bindNetEvents();
  }

  // ---------------------------------------------------------------- red

  bindNetEvents() {
    const net = this.net;

    net.on('joined', (data) => {
      this.myId = data.id;
      this.myTeam = data.team;
      this.myPosition = data.position || 'FIELD';
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

    // Cambio de skin/posición en partida: la skin y la posición quedan
    // "horneadas" en el personaje al construirlo (material/nombre), así
    // que se recrea con los datos nuevos en vez de intentar mutarlo.
    net.on('playerUpdated', (p) => {
      this.characters.get(p.id)?.dispose();
      this.characters.delete(p.id);
      this.addCharacter(p);
      this.nicknames.set(p.id, p.nickname);
      if (p.id === this.myId) this.myPosition = p.position;
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

      const now = performance.now();
      if (data.offender === this.myId) {
        this.local.stunnedUntil = now + data.stunMs;
        if (data.type === 'slide') {
          // Corta el lunge ya mismo y queda tendido un rato antes de
          // pararse, como el final de una barrida normal — en vez de
          // saltar de golpe a la pose de aturdido de pie.
          this.local.slideUntil = now;
          this.local.groundUntil = now + ACTIONS.FOUL_GROUND_MS;
        }
      }
      if (data.victim === this.myId && Array.isArray(data.dir)) {
        // Cae empujado en la dirección del golpe (velocidad del infractor).
        this.local.knockedUntil = now + ACTIONS.KNOCKBACK_MS;
        this.local.knockDirX = data.dir[0];
        this.local.knockDirZ = data.dir[1];
        this.local.yaw = Math.atan2(data.dir[0], data.dir[1]);
      }
    });

    net.on('steal', (data) => {
      if (data.by === this.myId) this.hud.message('¡Balón robado!');
      else if (data.from === this.myId) this.hud.message('Te robaron el balón');
    });

    net.on('possession', (data) => {
      this.ballOwnerId = data.id;
      this.ballOwnerSetAt = performance.now();
    });

    net.on('caught', (data) => {
      if (data.id === this.myId) {
        this.local.holding = true;
        this.hud.message('¡Atajada!');
      }
    });

    net.on('kicked', (data) => {
      if (data.id === this.ballOwnerId) {
        this.ballOwnerId = null;
        this.ballOwnerSetAt = performance.now();
      }
      const ch = this.characters.get(data.id);
      if (ch && data.id !== this.myId) ch.setAnim(ANIM.KICK);
      this.sound.playShot();
    });
  }

  addCharacter(p) {
    if (this.characters.has(p.id)) return;
    const ch = new SteveCharacter(p.team, p.nickname, p.skin, p.position);
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

    if (this.myId) this.hud.setPing(this.net.ping);
  }

  updateLocalPlayer(dt) {
    if (!this.myId) return;
    const L = this.local;
    const now = performance.now();
    const stunned = now < L.stunnedUntil;
    const sliding = now < L.slideUntil;
    const lowDiving = now < L.lowDiveUntil; // arquero: vuelo bajo lateral
    // El vuelo bajo termina (por tiempo, no por soltar el botón — ver
    // trigger más abajo): arranca la MISMA recuperación tendido-en-el-suelo
    // que la clavada alta (mismo PLAYER.DIVE_GROUND_MS), en vez de poder
    // pararse al instante.
    if (L.wasLowDiving && !lowDiving) L.diveGroundUntil = now + PLAYER.DIVE_GROUND_MS;
    L.wasLowDiving = lowDiving;
    const diveGrounded = now < L.diveGroundUntil; // arquero: tendido tras cualquier clavada
    const grounded = now < L.groundUntil; // infractor de barrida, tendido
    const knocked = now < L.knockedUntil; // víctima de falta, cayendo

    // Si ya no tiene la posesión (pateó, se la robaron, etc.) deja de
    // sostenerla en las manos.
    if (L.holding && this.ballOwnerId !== this.myId) L.holding = false;

    // Cámara 360 (no rota al personaje).
    const md = this.input.consumeMouseDelta();
    this.cameraCtrl.applyMouseDelta(md.x, md.y);

    // Barrer y cruzar pie no tienen sentido con el balón ya en tus propios
    // pies — quedan bloqueados mientras lo controlás.
    const controllingBall = this.ballOwnerId === this.myId;

    // ---- acciones
    if (!stunned && !sliding && !knocked && !lowDiving && !L.diving && !diveGrounded) {
      // Remate cargado (sin cooldown): mantener clic izq llena la barra
      // y muestra el recorrido previsto según la cámara.
      if (this.input.kickHeld) {
        this.kickCharge = Math.min(1, this.kickCharge + (dt * 1000) / ACTIONS.KICK_CHARGE_TIME_MS);
      }
      if (this.input.consume('kickRelease')) {
        // Se envía la carga cruda (0..1), la posición actual, el pitch de
        // la cámara y la velocidad real del jugador (Primera Ley de
        // Newton: el servidor SUMA esta velocidad al impulso del remate,
        // nunca lo reemplaza — un remate suave en plena carrera conserva
        // la inercia en vez de sentirse "clavado").
        this.net.sendKick(this.cameraCtrl.yaw, this.kickCharge, L.pos, this.cameraCtrl.pitch, [L.velX, L.velZ]);
        L.anim = ANIM.KICK;
        // Bloqueo de pose bien corto: solo lo justo para que se note el
        // swing, sin trabar remates consecutivos rápidos.
        L.actionUntil = now + 120;
        L.justKicked = true; // fuerza reiniciar la animación aunque siga en ANIM.KICK
        // Orientar la patada hacia la cámara.
        L.yaw = this.cameraCtrl.yaw;
        this.kickCharge = 0;
      }
      // Cruzar pie: SIN cooldown ni animación — spameable o cronometrado
      // al llegar la pelota.
      if (!controllingBall && this.input.consume('extend')) {
        this.net.sendChallenge('extend');
      }
      // Clic derecho: en el aire (arquero, moviéndose claramente al
      // costado) dispara el clavado; parado, es barrida normal salvo que
      // el arquero mantenga A/D sin W, ahí es vuelo bajo. Mismo botón,
      // se ramifica según esté en el aire o no.
      if (!controllingBall && this.input.consume('slide')) {
        const axis = this.input.moveAxis;
        if (this.myPosition === 'GK' && !L.onGround) {
          if (Math.abs(axis.x) > 0.3) {
            const camYaw = this.cameraCtrl.yaw;
            const side = Math.sign(axis.x);
            L.diving = true;
            L.diveDirX = -side * Math.cos(camYaw);
            L.diveDirZ = side * Math.sin(camYaw);
            L.velY = PLAYER.JUMP_SPEED * Math.sqrt(PLAYER.DIVE_HEIGHT_MULT);
          }
        } else if (L.onGround) {
          // Arquero moviéndose al costado (A/D, sin W) + barrida = vuelo
          // bajo en vez de barrida normal — la barrida sigue siendo en
          // línea recta o presionando W. El vuelo bajo NO tiene cooldown
          // (solo la barrida recta lo tiene).
          if (this.myPosition === 'GK' && Math.abs(axis.x) > 0.3 && Math.abs(axis.z) < 0.4) {
            const camYaw = this.cameraCtrl.yaw;
            const side = Math.sign(axis.x);
            this.net.sendChallenge('lowdive', { side });
            L.lowDiveUntil = now + ACTIONS.LOW_DIVE_DURATION_MS;
            L.lowDiveDirX = -side * Math.cos(camYaw);
            L.lowDiveDirZ = side * Math.sin(camYaw);
          } else if (now > L.slideCdUntil) {
            this.net.sendChallenge('slide');
            L.slideUntil = now + ACTIONS.SLIDE_DURATION_MS;
            L.slideCdUntil = now + ACTIONS.SLIDE_COOLDOWN_MS;
            L.slideDir = L.yaw;
          }
        }
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

    // Recorrido previsto + barra de poder mientras se carga el remate.
    const charging =
      this.input.kickHeld && !stunned && !sliding && !knocked && !L.diving && !lowDiving && !diveGrounded && !L.holding;
    this.aimLine.visible = charging;
    if (charging) this.updateAimTrajectory();
    this.hud.setPower(charging ? this.kickCharge : null);

    // ---- movimiento
    let moveX = 0;
    let moveZ = 0;
    let targetSpeed = 0;
    let axisPresent = false;
    const shiftHeld = this.input.sprint;

    if (knocked) {
      // Empujón de la falta: sin control, cae en la dirección del golpe
      // con velocidad decayendo (igual patrón que el lunge de la barrida).
      const t = (L.knockedUntil - now) / ACTIONS.KNOCKBACK_MS;
      L.curSpeed = ACTIONS.KNOCKBACK_SPEED * t;
      moveX = L.knockDirX;
      moveZ = L.knockDirZ;
    } else if (L.diving) {
      // Clavado del arquero: deriva lateral constante mientras está en
      // el aire, sin control de WASD (aterriza solo con la gravedad normal).
      L.curSpeed = PLAYER.DIVE_SIDE_SPEED;
      moveX = L.diveDirX;
      moveZ = L.diveDirZ;
    } else if (diveGrounded) {
      // Recién aterrizado del clavado: tendido de costado, sin control,
      // frena con la misma inercia que un aturdido normal.
      L.curSpeed = Math.max(0, L.curSpeed - PLAYER.DECEL * dt);
    } else if (lowDiving) {
      // Vuelo bajo del arquero: MISMA lógica que la barrida recta —
      // arranca con la velocidad real que traía al iniciarlo y frena solo
      // por deceleración natural, sin prolongarse por mantener el botón
      // presionado (antes usaba una velocidad constante todo el tiempo).
      moveX = L.lowDiveDirX;
      moveZ = L.lowDiveDirZ;
      L.curSpeed = Math.max(0, L.curSpeed - ACTIONS.SLIDE_DECEL * dt);
    } else if (sliding) {
      // La barrida es un lunge sin control de dirección: arranca con la
      // velocidad real que traía el jugador (parado/trote/sprint) y frena
      // sola por deceleración natural — parado apenas se desliza, y
      // corriendo recorre más distancia cuanto más rápido venía.
      moveX = Math.sin(L.slideDir);
      moveZ = Math.cos(L.slideDir);
      L.curSpeed = Math.max(0, L.curSpeed - ACTIONS.SLIDE_DECEL * dt);
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
        targetSpeed = wantsSprint ? PLAYER.SPRINT_SPEED : PLAYER.WALK_SPEED;

        // Correr de espaldas es más lento: cuanto más apunta el movimiento
        // contra el frente del cuerpo (cámara), más se reduce la velocidad.
        const backDot = moveX * Math.sin(camYaw) + moveZ * Math.cos(camYaw);
        if (backDot < 0) targetSpeed *= 1 + backDot * (1 - PLAYER.BACKPEDAL_MULT);

        // Estilo strafe: el cuerpo mantiene el frente hacia la cámara;
        // moverse al costado es un desplazamiento lateral, no un giro.
        L.yaw = lerpAngle(L.yaw, camYaw, 1 - Math.exp(-14 * dt));
      }

      // Aceleración/desaceleración: la velocidad real (curSpeed, nunca
      // expuesta en el HUD) persigue el objetivo en vez de saltar a él —
      // el trote reacciona rápido, el sprint tarda más en estirarse, y al
      // soltar/frenar hay una breve inercia de desaceleración.
      const accel = L.sprinting ? PLAYER.ACCEL_SPRINT : PLAYER.ACCEL_JOG;
      const rate = targetSpeed > L.curSpeed ? accel : PLAYER.DECEL;
      const diff = targetSpeed - L.curSpeed;
      const maxDelta = rate * dt;
      L.curSpeed += Math.sign(diff) * Math.min(Math.abs(diff), maxDelta);
    } else {
      // Aturdido: sin control, pero igual frena con inercia hasta 0.
      L.curSpeed = Math.max(0, L.curSpeed - PLAYER.DECEL * dt);
    }
    const speed = L.curSpeed;
    // Velocidad real con dirección (no solo magnitud) — se manda al patear
    // para que el remate herede la inercia del movimiento (Newton).
    L.velX = moveX * speed;
    L.velZ = moveZ * speed;

    // Stamina: drena solo al sprintar de verdad. NO recarga mientras Shift
    // siga presionado (aunque ya no se pueda sprintar) — hay que soltarlo.
    // Parado del todo (sin ejes ni Shift) recarga más rápido.
    if (L.sprinting) {
      L.stamina = Math.max(0, L.stamina - PLAYER.STAMINA_DRAIN_PER_S * dt);
    } else if (!shiftHeld && !sliding && !stunned && !knocked) {
      const idleBonus = axisPresent ? 1 : PLAYER.STAMINA_REGEN_IDLE_MULT;
      L.stamina = Math.min(PLAYER.STAMINA_MAX, L.stamina + PLAYER.STAMINA_REGEN_PER_S * idleBonus * dt);
    }
    this.hud.setStamina(L.stamina / PLAYER.STAMINA_MAX);

    L.pos.x += moveX * speed * dt;
    L.pos.z += moveZ * speed * dt;

    // Colisión con otros jugadores: no se atraviesan (predicción local;
    // el servidor la resuelve de forma autoritativa para lo que ven los
    // demás). Se excluye a quien está saltando o barriéndose — ese
    // contacto lo maneja el sistema de faltas, no un empujón genérico.
    if (L.pos.y < 0.5) {
      for (const [id, ch] of this.characters) {
        if (id === this.myId || !ch.ready) continue;
        if (ch.animState === ANIM.SLIDE || ch.group.position.y > 0.5) continue;
        const dx = L.pos.x - ch.group.position.x;
        const dz = L.pos.z - ch.group.position.z;
        const minDist = PLAYER.RADIUS * 2;
        const distSq = dx * dx + dz * dz;
        if (distSq < minDist * minDist && distSq > 1e-6) {
          const dist = Math.sqrt(distSq);
          const push = minDist - dist;
          L.pos.x += (dx / dist) * push;
          L.pos.z += (dz / dist) * push;
        }
      }
    }

    // Los jugadores viven DENTRO de la cancha: nadie rodea el arco por fuera.
    L.pos.x = THREE.MathUtils.clamp(L.pos.x, -HALF_L + 0.4, HALF_L - 0.4);
    L.pos.z = THREE.MathUtils.clamp(L.pos.z, -HALF_W + 0.4, HALF_W - 0.4);

    // Salto / gravedad.
    if (!L.onGround) {
      L.velY -= PLAYER.GRAVITY * dt;
      L.pos.y += L.velY * dt;
      if (L.pos.y <= 0) {
        L.pos.y = 0;
        L.velY = 0;
        L.onGround = true;
        // Aterrizó del clavado: queda tendido de costado un instante antes
        // de levantarse — salvo que ya haya atajado el balón en el aire,
        // en cuyo caso aterriza directo en la pose de atajada (más lógico
        // que desplomarse habiendo agarrado la pelota).
        if (L.diving && !L.holding) L.diveGroundUntil = now + PLAYER.DIVE_GROUND_MS;
        L.diving = false; // aterrizó: devuelve el control normal
      }
    }

    // ---- estado de animación
    // inAction se recalcula ACÁ (no al principio de la función): el bloque
    // de acciones recién actualizó actionUntil este mismo frame, así que
    // calcularlo antes dejaba la pose recién iniciada (kick/extend) un
    // frame pisada por IDLE/JOG.
    const inAction = now < L.actionUntil;
    // Prioridad: cayendo por el golpe > balón atajado en las manos >
    // clavado de arquero > tendido tras aterrizar del clavado > vuelo bajo
    // > tendido tras cometer la falta > aturdido de pie > barrida > acción
    // en curso > salto > movimiento.
    if (knocked) L.anim = ANIM.KNOCKED;
    else if (L.holding) L.anim = ANIM.CATCH;
    else if (L.diving) L.anim = ANIM.DIVE;
    else if (diveGrounded) L.anim = ANIM.DIVE_GROUND;
    else if (lowDiving) L.anim = ANIM.LOW_DIVE;
    else if (grounded) L.anim = ANIM.SLIDE; // tendido, misma pose que la barrida
    else if (stunned) L.anim = ANIM.STUNNED;
    else if (sliding) L.anim = ANIM.SLIDE;
    else if (inAction && L.anim === ANIM.KICK) {
      /* mantener pose de acción */
    } else if (!L.onGround) L.anim = ANIM.JUMP;
    else if (speed > 0) L.anim = L.sprinting ? ANIM.SPRINT : ANIM.JOG;
    else L.anim = ANIM.IDLE;

    // Trote/sprint en bucle (con o sin balón), tono según la velocidad
    // real — solo durante el trote/sprint genuino, no en barrida/clavado/etc.
    const jogging = L.anim === ANIM.JOG || L.anim === ANIM.SPRINT;
    this.sound.updateFootsteps(jogging ? speed : 0, controllingBall);

    // Círculo del área de control, siempre bajo los pies del jugador local.
    this.controlRing.visible = true;
    this.controlRing.position.set(L.pos.x, 0.02, L.pos.z);

    // Aplicar al mesh propio.
    const ch = this.characters.get(this.myId);
    if (ch) {
      ch.group.position.copy(L.pos);
      ch.group.rotation.y = L.yaw;
      // Patadas consecutivas rápidas: ANIM.KICK no cambia entre una y
      // otra, así que setAnim() (que solo reacciona a un cambio de
      // estado) no reiniciaría el swing — playKick() lo fuerza siempre.
      if (L.justKicked) {
        ch.playKick();
        L.justKicked = false;
      } else {
        ch.setAnim(L.anim);
      }
      ch.update(dt, speed);
    }

    // Esfera de depuración de la asistencia de atajada (solo ?debug=1):
    // SIEMPRE centrada en el arquero, en cualquier acción. Se calcula DESPUÉS
    // de ch.update() (pose del frame ya aplicada) y se centra en el bounding
    // box real y preciso del cuerpo (huesos posados, no un offset fijo tipo
    // "pos.y + HEIGHT/2") — antes ese offset asumía una pose de pie, así que
    // en un clavado o vuelo bajo (cuerpo inclinado en diagonal) el personaje
    // se veía "salir" de la esfera aunque la posición base fuera correcta.
    if (this.debugCatchSphere) {
      const showSphere = this.myPosition === 'GK';
      this.debugCatchSphere.visible = showSphere;
      if (showSphere && ch?.ready) {
        ch.group.updateMatrixWorld(true);
        this._debugSphereBox.setFromObject(ch.body, true);
        this._debugSphereBox.getCenter(this.debugCatchSphere.position);
      }
    }
  }

  /**
   * Recalcula el recorrido previsto del remate en curso, muestreando la
   * MISMA física que aplicará el servidor (misma curva de potencia por
   * carga, mismo cálculo de altura por pitch — ver GameRoom.onKick) para
   * que la curva coincida con el resultado real. Se llama cada frame
   * mientras se carga, así reacciona en vivo tanto a la potencia como a
   * hacia dónde apunta la cámara.
   */
  updateAimTrajectory() {
    const L = this.local;
    const dirYaw = this.cameraCtrl.yaw;
    const pitch = this.cameraCtrl.pitch;
    const pitchNorm = 1 - (pitch - CAMERA.PITCH_MIN) / (CAMERA.PITCH_MAX - CAMERA.PITCH_MIN);

    let speed;
    if (this.kickCharge <= ACTIONS.KICK_PIVOT_CHARGE) {
      const t = this.kickCharge / ACTIONS.KICK_PIVOT_CHARGE;
      speed = ACTIONS.KICK_MIN_SPEED + (ACTIONS.KICK_PIVOT_SPEED - ACTIONS.KICK_MIN_SPEED) * Math.pow(t, ACTIONS.KICK_LOW_CURVE);
    } else {
      const t = (this.kickCharge - ACTIONS.KICK_PIVOT_CHARGE) / (1 - ACTIONS.KICK_PIVOT_CHARGE);
      speed = ACTIONS.KICK_PIVOT_SPEED + (ACTIONS.KICK_POWER - ACTIONS.KICK_PIVOT_SPEED) * Math.pow(t, ACTIONS.KICK_CURVE);
    }
    // Curva progresiva no lineal: raso mirando al piso, sube cada vez más
    // rápido cuanto más se mira al cielo (misma fórmula que el servidor).
    const liftY = ACTIONS.KICK_LIFT_PITCH_MAX * Math.pow(pitchNorm, ACTIONS.KICK_LIFT_CURVE);
    const liftFraction = Math.pow(pitchNorm, ACTIONS.KICK_LIFT_CURVE);
    const horizSpeed = speed * (1 - ACTIONS.KICK_HORIZ_LIFT_PENALTY * liftFraction);
    // Newton: la inercia del jugador se suma al impulso (misma fórmula que
    // GameRoom.onKick), para que la línea de puntería anticipe el mismo
    // resultado que va a aplicar el servidor.
    const vx = Math.sin(dirYaw) * horizSpeed + L.velX * ACTIONS.KICK_MOMENTUM_CARRY;
    const vz = Math.cos(dirYaw) * horizSpeed + L.velZ * ACTIONS.KICK_MOMENTUM_CARRY;

    let px = L.pos.x + Math.sin(dirYaw) * 0.6;
    let pz = L.pos.z + Math.cos(dirYaw) * 0.6;
    let py = BALL.RADIUS + 0.15;
    let vy = liftY;

    const positions = this.aimLine.geometry.attributes.position.array;
    let count = 0;
    for (let i = 0; i < AIM_TRAJECTORY_POINTS; i++) {
      positions[i * 3] = px;
      positions[i * 3 + 1] = py;
      positions[i * 3 + 2] = pz;
      count++;
      if (py <= BALL.RADIUS && i > 0) break;
      px += vx * AIM_TRAJECTORY_STEP;
      pz += vz * AIM_TRAJECTORY_STEP;
      vy -= BALL.GRAVITY * AIM_TRAJECTORY_STEP;
      py = Math.max(BALL.RADIUS, py + vy * AIM_TRAJECTORY_STEP);
    }
    this.aimLine.geometry.setDrawRange(0, count);
    this.aimLine.geometry.attributes.position.needsUpdate = true;
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
    // El snapshot interpolado representa el estado de ~INTERP_DELAY_MS en
    // el pasado (para que el resto de la interpolación sea suave) — si un
    // evento instantáneo (possession/kicked, ver bindNetEvents) acaba de
    // cambiar this.ballOwnerId, ese valor retrasado todavía muestra el
    // dueño VIEJO durante ese margen. Pisarlo igual reseteaba local.holding
    // casi al instante de atajar (rompía la atajada: la pelota volvía a
    // los pies) — se espera a que el snapshot alcance el evento reciente.
    if (pair && performance.now() - this.ballOwnerSetAt > NET.INTERP_DELAY_MS) {
      this.ballOwnerId = pair.b.o;
    }

    if (this.ballOwnerId === this.myId) {
      // Predicción local del control: el balón se "pega" a los pies y se
      // separa más al trotar y aún más al sprintar (control realista) —
      // salvo que el arquero lo tenga atajado en las manos, ahí queda fijo
      // cerca del pecho en vez de seguir el ritmo de los pies.
      const L = this.local;
      const bp = this.ball.mesh.position;
      const k = 1 - Math.exp(-DRIBBLE.FOLLOW_RATE * dt);
      let tx;
      let tz;
      let ty;
      if (L.holding) {
        tx = L.pos.x + Math.sin(L.yaw) * 0.45;
        tz = L.pos.z + Math.cos(L.yaw) * 0.45;
        ty = L.pos.y + 1.15;
      } else {
        const dist = L.anim === ANIM.SPRINT ? DRIBBLE.DIST_SPRINT : L.anim === ANIM.JOG ? DRIBBLE.DIST_JOG : DRIBBLE.DIST_IDLE;
        tx = L.pos.x + Math.sin(L.yaw) * dist;
        tz = L.pos.z + Math.cos(L.yaw) * dist;
        ty = BALL.RADIUS;
      }
      bp.x += (tx - bp.x) * k;
      bp.z += (tz - bp.z) * k;
      bp.y += (ty - bp.y) * k;

      // Misma colisión con paredes/red que el servidor: el balón conducido
      // no atraviesa bandas ni fondos (visualmente tampoco).
      if (Math.abs(bp.z) > HALF_W - BALL.RADIUS) bp.z = Math.sign(bp.z) * (HALF_W - BALL.RADIUS);
      const inGoalMouth = Math.abs(bp.z) < FIELD.GOAL_WIDTH / 2;
      if (!inGoalMouth) {
        if (Math.abs(bp.x) > HALF_L - BALL.RADIUS) bp.x = Math.sign(bp.x) * (HALF_L - BALL.RADIUS);
      } else if (Math.abs(bp.x) > HALF_L + FIELD.GOAL_DEPTH - BALL.RADIUS) {
        bp.x = Math.sign(bp.x) * (HALF_L + FIELD.GOAL_DEPTH - BALL.RADIUS);
      }
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
