/**
 * Constantes compartidas entre cliente y servidor.
 * Cualquier cambio de gameplay/física debe hacerse aquí para
 * mantener ambas simulaciones consistentes.
 */

export const FIELD = {
  LENGTH: 60, // eje X (de arco a arco)
  WIDTH: 40, // eje Z
  GOAL_WIDTH: 8,
  GOAL_HEIGHT: 2.6,
  GOAL_DEPTH: 2.2,
  WALL_RESTITUTION: 0.55,
};

export const BALL = {
  RADIUS: 0.35,
  GRAVITY: 20,
  GROUND_RESTITUTION: 0.55,
  ROLL_FRICTION: 0.6, // frenado por segundo (factor exponencial)
  AIR_DRAG: 0.12,
  MAX_SPEED: 30,
};

export const PLAYER = {
  HEIGHT: 1.8,
  RADIUS: 0.35,
  WALK_SPEED: 4.3,
  SPRINT_SPEED: 7.2,
  JUMP_SPEED: 7.5,
  GRAVITY: 20,
  // Stamina: se agota sprintando y se recarga por completo en ~5 s.
  STAMINA_MAX: 100,
  STAMINA_DRAIN_PER_S: 28,
  STAMINA_REGEN_PER_S: 20,
  STAMINA_MIN_TO_SPRINT: 10,
};

export const DRIBBLE = {
  // Distancia del balón a los pies según el estado de movimiento.
  DIST_IDLE: 0.5,
  DIST_JOG: 0.72,
  DIST_SPRINT: 1.15,
  CONTROL_RADIUS: 1.05, // distancia para capturar un balón libre
  MAX_CAPTURE_SPEED: 9, // el balón muy rápido no se controla al instante
  MAX_CAPTURE_HEIGHT: 0.9,
  FOLLOW_RATE: 14, // qué tan rápido el balón persigue el punto de control
};

export const ACTIONS = {
  KICK_POWER: 16,
  KICK_LIFT: 4.5,
  KICK_RANGE: 1.5,
  KICK_COOLDOWN_MS: 450,

  // Cruzar pie (clic ruedita): extensión defensiva corta.
  EXTEND_REACH: 1.0,
  EXTEND_DURATION_MS: 350,
  EXTEND_COOLDOWN_MS: 900,

  // Barrida (clic derecho): mismo criterio robo/falta pero con lunge.
  SLIDE_REACH: 1.45,
  SLIDE_DURATION_MS: 650,
  SLIDE_SPEED: 9,
  SLIDE_COOLDOWN_MS: 2200,

  STEAL_RADIUS: 0.62, // el pie debe conectar realmente con la pelota
  FOUL_RADIUS: 0.48, // radio de las piernas del rival para cobrar falta
  FOUL_STUN_MS: 3000,
};

export const NET = {
  SERVER_TICK_HZ: 30,
  SNAPSHOT_HZ: 20,
  CLIENT_SEND_HZ: 20,
  INTERP_DELAY_MS: 120,
  MAX_PLAYERS: 8, // 4v4
};

// Estados de animación (byte compacto en snapshots).
export const ANIM = {
  IDLE: 0,
  JOG: 1,
  SPRINT: 2,
  JUMP: 3,
  KICK: 4,
  EXTEND: 5,
  SLIDE: 6,
  STUNNED: 7,
};

export const TEAM_COLORS = [0xd63b3b, 0x2f6fd6]; // rojo vs azul
