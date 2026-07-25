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

/** Punto más cercano de un segmento vertical (cápsula) al centro del balón. */
function closestPointOnCapsule(px, py0, py1, pz, bx, by, bz) {
  const cy = Math.max(py0, Math.min(py1, by));
  return { x: px, y: cy, z: pz };
}

/**
 * Colisión balón vs. extremidades de un jugador (posición + yaw).
 * Devuelve true si hubo contacto (y muta pos/vel del balón).
 */
export function collideBallWithPlayer(ball, player) {
  const sin = Math.sin(player.yaw);
  const cos = Math.cos(player.yaw);
  let hit = false;

  for (const c of LIMB_CAPSULES) {
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
