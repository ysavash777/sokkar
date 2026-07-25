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
  MAX_SPEED: 44,
};

export const PLAYER = {
  HEIGHT: 1.8,
  RADIUS: 0.35,
  WALK_SPEED: 5.2,
  SPRINT_SPEED: 8.6,
  BACKPEDAL_MULT: 0.62, // correr de espaldas es más lento
  // Aceleración/desaceleración (m/s²): la velocidad real persigue el
  // objetivo — trote responde rápido, el sprint tarda más en estirarse,
  // y al soltar se frena con inercia corta.
  ACCEL_JOG: 16,
  ACCEL_SPRINT: 11,
  DECEL: 20,
  JUMP_SPEED: 7.5,
  GRAVITY: 20,
  // Stamina: se agota sprintando; NO recarga mientras Shift esté presionado
  // (evita el parpadeo trote/sprint al rozar el umbral). Recarga completa
  // en ~5 s al soltar Shift; parado del todo recarga más rápido.
  STAMINA_MAX: 115,
  STAMINA_DRAIN_PER_S: 26,
  STAMINA_REGEN_PER_S: 23,
  STAMINA_REGEN_IDLE_MULT: 1.6,
  STAMINA_MIN_TO_SPRINT: 10,
};

export const DRIBBLE = {
  // Distancia del balón a los pies según el estado de movimiento.
  DIST_IDLE: 0.5,
  DIST_JOG: 0.72,
  DIST_SPRINT: 1.15,
  FOLLOW_RATE: 14, // qué tan rápido el balón persigue el punto de control
  CAPTURE_RAMP_S: 0.35, // rampa del seguimiento tras capturar (primer toque suave)
};

export const ACTIONS = {
  // Remate cargado: mantener clic izq llena la barra (SIN cooldown).
  // Potencia por tramos MUY adelantada: casi al toque (KICK_PIVOT_CHARGE)
  // ya se siente un remate fuerte (KICK_PIVOT_SPEED); de ahí a la barra
  // llena sigue creciendo hasta KICK_POWER (el único tramo que ya estaba bien).
  KICK_POWER: 40, // velocidad a barra llena (charge = 1)
  KICK_MIN_SPEED: 0.72, // velocidad con la barra recién empezada (toque ~1 m)
  KICK_PIVOT_CHARGE: 0.2, // a partir de acá el remate ya "se siente"
  KICK_PIVOT_SPEED: 15, // velocidad en KICK_PIVOT_CHARGE
  KICK_LOW_CURVE: 2, // exponente del tramo [0, PIVOT]: ease-in suave (toque sigue siendo toque)
  KICK_CURVE: 1.15, // exponente del tramo [PIVOT, 1]: crecimiento sostenido hasta el máximo
  KICK_LIFT: 8,
  KICK_RANGE: 1.5,
  KICK_CHARGE_TIME_MS: 900,
  RECAPTURE_DELAY_MS: 450, // quien patea no re-captura su propio pase al instante

  // Cruzar pie (clic ruedita): SIN cooldown — se puede spamear o cronometrar.
  // Controla/roba el balón si está dentro del área de control circular
  // alrededor del jugador (cualquier ángulo). Es la única forma de "recibir"
  // un balón libre (si no se usa, la pelota pasa entre las piernas).
  EXTEND_REACH: 1.0, // usado solo para la falta (pie extendido hacia el rival)
  EXTEND_DURATION_MS: 350,
  CONTROL_AREA_RADIUS: 0.9, // círculo en la base del jugador (el personaje cabe en él)
  CONTROL_AREA_HEIGHT: 2.0, // cilindro de pies a cabeza: también controla balones que vienen volando

  // Barrida (clic derecho): si toca el balón, se lo queda pegado;
  // si contacta al rival, es falta.
  SLIDE_REACH: 1.45,
  SLIDE_DURATION_MS: 650,
  SLIDE_SPEED: 10.5,
  SLIDE_COOLDOWN_MS: 2200,
  SLIDE_BODY_FOUL_RADIUS: 0.7, // contacto de cuerpo durante la barrida

  STEAL_RADIUS: 0.62, // el pie debe conectar realmente con la pelota
  FOUL_RADIUS: 0.48, // radio de las piernas del rival para cobrar falta
  FOUL_STUN_MS: 3000,
  FOUL_GROUND_MS: 700, // el infractor en barrida queda tendido antes de pararse

  // Mano: contacto del balón con el brazo (entre hombro y mano), en
  // cualquier animación (salto, barrida, etc.). Siempre falta.
  HANDBALL_COOLDOWN_MS: 1500,

  // Empujón que recibe la víctima de una falta física (no la de mano):
  // cae en la dirección del impacto (velocidad/posición del infractor).
  KNOCKBACK_SPEED: 6,
  KNOCKBACK_MS: 450,
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
  KNOCKED: 8, // víctima de una falta, cayendo por el impacto
};

export const TEAM_COLORS = [0xd63b3b, 0x2f6fd6]; // rojo vs azul
