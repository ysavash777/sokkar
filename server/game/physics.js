/**
 * Física del balón y colisiones por extremidad, lado servidor.
 * El servidor es la autoridad del balón: los clientes solo mandan
 * su propio estado + eventos de acción.
 */
import { FIELD, BALL } from '../../shared/constants.js';

const HALF_L = FIELD.LENGTH / 2;
const HALF_W = FIELD.WIDTH / 2;

/** Cápsulas de colisión por extremidad, en pose base, relativas al jugador (yaw aplicado). */
export const LIMB_CAPSULES = [
  // [offsetX(lateral), y0, y1, offsetZ(frontal), radio]
  { name: 'legL', lat: -0.12, y0: 0.05, y1: 0.85, fwd: 0, r: 0.14 },
  { name: 'legR', lat: 0.12, y0: 0.05, y1: 0.85, fwd: 0, r: 0.14 },
  { name: 'torso', lat: 0, y0: 0.85, y1: 1.5, fwd: 0, r: 0.26 },
  { name: 'armL', lat: -0.35, y0: 0.8, y1: 1.45, fwd: 0, r: 0.12 },
  { name: 'armR', lat: 0.35, y0: 0.8, y1: 1.45, fwd: 0, r: 0.12 },
  { name: 'head', lat: 0, y0: 1.55, y1: 1.75, fwd: 0, r: 0.24 },
];

// Solo los brazos (entre hombro y mano): usados para detectar "mano".
const ARM_CAPSULES = LIMB_CAPSULES.filter((c) => c.name === 'armL' || c.name === 'armR');

/** Punto más cercano de un segmento vertical (cápsula) al centro del balón. */
function closestPointOnCapsule(px, py0, py1, pz, bx, by, bz) {
  const cy = Math.max(py0, Math.min(py1, by));
  return { x: px, y: cy, z: pz };
}

/**
 * Colisión balón vs. extremidades de un jugador (posición + yaw).
 * Devuelve true si hubo contacto (y muta pos/vel del balón).
 */
export function collideBallWithPlayer(ball, player, capsules = LIMB_CAPSULES) {
  const sin = Math.sin(player.yaw);
  const cos = Math.cos(player.yaw);
  let hit = false;

  for (const c of capsules) {
    // Rotar el offset local (lat, fwd) por el yaw del jugador.
    const ox = player.pos.x + c.lat * cos + c.fwd * sin;
    const oz = player.pos.z - c.lat * sin + c.fwd * cos;
    const p = closestPointOnCapsule(ox, player.pos.y + c.y0, player.pos.y + c.y1, oz, ball.pos.x, ball.pos.y, ball.pos.z);

    const dx = ball.pos.x - p.x;
    const dy = ball.pos.y - p.y;
    const dz = ball.pos.z - p.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    const minDist = BALL.RADIUS + c.r;

    if (distSq < minDist * minDist && distSq > 1e-6) {
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const ny = dy / dist;
      const nz = dz / dist;
      // Separar el balón de la extremidad.
      const push = minDist - dist;
      ball.pos.x += nx * push;
      ball.pos.y += ny * push;
      ball.pos.z += nz * push;
      // Rebote amortiguado sobre la normal.
      const vn = ball.vel.x * nx + ball.vel.y * ny + ball.vel.z * nz;
      if (vn < 0) {
        const rest = 0.45;
        ball.vel.x -= (1 + rest) * vn * nx;
        ball.vel.y -= (1 + rest) * vn * ny;
        ball.vel.z -= (1 + rest) * vn * nz;
      }
      hit = true;
    }
  }
  return hit;
}

/**
 * Colisión balón vs. brazos (hombro a mano) de un jugador, en CUALQUIER
 * momento — dribbling, salto, barrida, lo que sea. Se usa para detectar
 * "mano" y cobrar falta, independiente del resto del cuerpo.
 */
export function collideBallWithArms(ball, player) {
  return collideBallWithPlayer(ball, player, ARM_CAPSULES);
}

/**
 * Colisión balón vs. el CUERPO ENTERO de un jugador barriéndose: una
 * cápsula horizontal a ras de piso desde la cadera hasta el pie extendido.
 * El balón no atraviesa el cuerpo venga de donde venga, y la respuesta
 * depende de la ZONA de contacto y de las velocidades de ambos:
 *
 *   - PUNTA (pie extendido, t > 0.7): despeje frontal — el balón sale
 *     hacia adelante de la barrida con la energía combinada del balón y
 *     de la carrera del jugador (clave para empujar un pase al arco o
 *     despejar en defensa).
 *   - PIERNAS (0.35 < t < 0.7): rebote de fuerza media.
 *   - TORSO (t < 0.35): absorbe la energía — el balón muere casi ahí.
 *
 * Devuelve true si hubo contacto.
 */
export function collideBallWithSlidingBody(ball, player) {
  const sin = Math.sin(player.yaw);
  const cos = Math.cos(player.yaw);
  const r = 0.32; // radio del cuerpo tendido
  const y = 0.28; // altura del eje del cuerpo sobre el piso
  const ax = player.pos.x + sin * 0.05;
  const az = player.pos.z + cos * 0.05;
  const bx = player.pos.x + sin * 1.15;
  const bz = player.pos.z + cos * 1.15;

  // Punto más cercano del segmento [a,b] al centro del balón.
  // t = 0 -> torso/cadera, t = 1 -> punta del pie extendido.
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  let t = ((ball.pos.x - ax) * abx + (ball.pos.z - az) * abz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t;
  const cz = az + abz * t;

  const dx = ball.pos.x - cx;
  const dy = ball.pos.y - y;
  const dz = ball.pos.z - cz;
  const distSq = dx * dx + dy * dy + dz * dz;
  const minDist = BALL.RADIUS + r;
  if (distSq >= minDist * minDist || distSq < 1e-6) return false;

  const dist = Math.sqrt(distSq);
  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;
  const push = minDist - dist;
  ball.pos.x += nx * push;
  ball.pos.y += ny * push;
  ball.pos.z += nz * push;

  // Velocidades involucradas: la del balón y la de la carrera del jugador.
  const pvx = player.vel?.x ?? 0;
  const pvz = player.vel?.z ?? 0;
  const playerSpeed = Math.hypot(pvx, pvz);
  const ballSpeed = Math.hypot(ball.vel.x, ball.vel.z);

  if (t > 0.7) {
    // PUNTA: despeje frontal en la dirección de la barrida.
    const out = ballSpeed * 0.5 + playerSpeed * 1.1 + 1.5;
    ball.vel.x = sin * out;
    ball.vel.z = cos * out;
    ball.vel.y = Math.min(2.5, out * 0.15);
  } else if (t < 0.35) {
    // TORSO: absorción — mata casi toda la energía del balón y apenas
    // lo arrastra con el envión del cuerpo.
    ball.vel.x = ball.vel.x * 0.15 + pvx * 0.3;
    ball.vel.z = ball.vel.z * 0.15 + pvz * 0.3;
    ball.vel.y = Math.abs(ball.vel.y) * 0.2;
  } else {
    // PIERNAS: rebote de fuerza media + parte del envión del jugador.
    const vn = ball.vel.x * nx + ball.vel.y * ny + ball.vel.z * nz;
    if (vn < 0) {
      const rest = 0.45;
      ball.vel.x -= (1 + rest) * vn * nx;
      ball.vel.y -= (1 + rest) * vn * ny;
      ball.vel.z -= (1 + rest) * vn * nz;
    }
    ball.vel.x += pvx * 0.35;
    ball.vel.z += pvz * 0.35;
  }

  // Nunca dejar componente de velocidad hacia adentro del cuerpo.
  const vnOut = ball.vel.x * nx + ball.vel.y * ny + ball.vel.z * nz;
  if (vnOut < 0) {
    ball.vel.x -= vnOut * nx;
    ball.vel.y -= vnOut * ny;
    ball.vel.z -= vnOut * nz;
  }
  return true;
}

/**
 * Detecta si el balón cruzó por completo la línea de gol (dentro del
 * ancho/alto del arco). No integra física, solo evalúa la posición.
 * Se usa tanto para el balón libre como para el balón conducido a los pies.
 */
export function checkGoalCrossing(ball) {
  const inGoalMouth = Math.abs(ball.pos.z) < FIELD.GOAL_WIDTH / 2 && ball.pos.y < FIELD.GOAL_HEIGHT + 0.5;
  if (inGoalMouth && Math.abs(ball.pos.x) > HALF_L + BALL.RADIUS) {
    return ball.pos.x > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Recorta la posición del balón para que no atraviese bandas, fondos ni
 * la red del arco (sin rebote). Dentro de la boca del arco permite avanzar
 * hasta el fondo de la red; fuera de ella, la línea de fondo es pared.
 */
export function clampToPitch(ball) {
  if (Math.abs(ball.pos.z) > HALF_W - BALL.RADIUS) {
    ball.pos.z = Math.sign(ball.pos.z) * (HALF_W - BALL.RADIUS);
  }
  const inGoalMouth = Math.abs(ball.pos.z) < FIELD.GOAL_WIDTH / 2;
  if (!inGoalMouth) {
    if (Math.abs(ball.pos.x) > HALF_L - BALL.RADIUS) {
      ball.pos.x = Math.sign(ball.pos.x) * (HALF_L - BALL.RADIUS);
    }
  } else if (Math.abs(ball.pos.x) > HALF_L + FIELD.GOAL_DEPTH - BALL.RADIUS) {
    ball.pos.x = Math.sign(ball.pos.x) * (HALF_L + FIELD.GOAL_DEPTH - BALL.RADIUS);
  }
}

/**
 * Integra el balón libre un paso dt. Devuelve 0 | 1 | -1:
 * 1 = gol en arco derecho (anota equipo 0), -1 = gol en arco izquierdo (anota equipo 1).
 */
export function stepBall(ball, dt) {
  // Gravedad + drag.
  ball.vel.y -= BALL.GRAVITY * dt;
  const drag = Math.exp(-BALL.AIR_DRAG * dt);
  ball.vel.x *= drag;
  ball.vel.z *= drag;

  ball.pos.x += ball.vel.x * dt;
  ball.pos.y += ball.vel.y * dt;
  ball.pos.z += ball.vel.z * dt;

  // Suelo: rebote + fricción de rodadura.
  if (ball.pos.y < BALL.RADIUS) {
    ball.pos.y = BALL.RADIUS;
    if (ball.vel.y < 0) ball.vel.y = -ball.vel.y * BALL.GROUND_RESTITUTION;
    if (Math.abs(ball.vel.y) < 0.8) ball.vel.y = 0;
    const roll = Math.exp(-BALL.ROLL_FRICTION * dt);
    ball.vel.x *= roll;
    ball.vel.z *= roll;
  }

  // Bandas laterales (Z).
  if (Math.abs(ball.pos.z) > HALF_W - BALL.RADIUS) {
    ball.pos.z = Math.sign(ball.pos.z) * (HALF_W - BALL.RADIUS);
    ball.vel.z = -ball.vel.z * FIELD.WALL_RESTITUTION;
  }

  // Fondos (X): abertura del arco.
  const inGoalMouth = Math.abs(ball.pos.z) < FIELD.GOAL_WIDTH / 2 && ball.pos.y < FIELD.GOAL_HEIGHT;
  if (Math.abs(ball.pos.x) > HALF_L - BALL.RADIUS) {
    if (inGoalMouth) {
      // Cruzó la línea de gol.
      if (Math.abs(ball.pos.x) > HALF_L + BALL.RADIUS) {
        return ball.pos.x > 0 ? 1 : -1;
      }
      // Fondo de la red.
      if (Math.abs(ball.pos.x) > HALF_L + FIELD.GOAL_DEPTH - BALL.RADIUS) {
        ball.pos.x = Math.sign(ball.pos.x) * (HALF_L + FIELD.GOAL_DEPTH - BALL.RADIUS);
        ball.vel.x *= -0.2;
        ball.vel.z *= 0.4;
      }
    } else {
      ball.pos.x = Math.sign(ball.pos.x) * (HALF_L - BALL.RADIUS);
      ball.vel.x = -ball.vel.x * FIELD.WALL_RESTITUTION;
    }
  }

  // Clamp de velocidad.
  const sp = Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z);
  if (sp > BALL.MAX_SPEED) {
    const k = BALL.MAX_SPEED / sp;
    ball.vel.x *= k;
    ball.vel.y *= k;
    ball.vel.z *= k;
  }
  return 0;
}
