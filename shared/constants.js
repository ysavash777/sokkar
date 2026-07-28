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
  // Área de meta: rectángulo frente a cada arco donde el arquero puede
  // atajar con las manos (fuera de ella, controla con los pies como
  // cualquier jugador).
  PENALTY_WIDTH: 20,
  PENALTY_DEPTH: 10,
};

// Rango de inclinación vertical de la cámara (pitch): también define,
// en el remate, cuánto "mira al cielo" o "mira al piso" el jugador.
export const CAMERA = {
  PITCH_MIN: -0.15,
  PITCH_MAX: 1.2,
};

export const BALL = {
  RADIUS: 0.35,
  GRAVITY: 20,
  GROUND_RESTITUTION: 0.55,
  // Frenado en el piso: subido (antes 0.6) para que no recorra tanto al
  // frenar — mitad arcade, no una desaceleración 100% realista. Combinado
  // con ROLL_STOP_SPEED para que no quede reptando a paso de tortuga
  // eternamente (el decaimiento exponencial puro nunca llega a 0 solo).
  ROLL_FRICTION: 1.6,
  ROLL_STOP_SPEED: 0.35, // por debajo de esto, se frena en seco
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
  // Duración del sprint (MAX/DRAIN) subida +50% respecto de la versión
  // anterior; DRAIN sin tocar y REGEN escalado junto con MAX para que el
  // tiempo de recarga completa (MAX/REGEN) se mantenga en los mismos ~5 s.
  STAMINA_MAX: 172.5,
  STAMINA_DRAIN_PER_S: 26,
  STAMINA_REGEN_PER_S: 34.5,
  STAMINA_REGEN_IDLE_MULT: 1.6,
  STAMINA_MIN_TO_SPRINT: 10,
  // Arquero: clavado lateral a media altura mientras salta y se mueve al
  // costado (con clic izquierdo). Solo disponible en posición GK.
  DIVE_SIDE_SPEED: 6.5,
  DIVE_HEIGHT_MULT: 0.5, // fracción de la altura de salto normal
  DIVE_GROUND_MS: 350, // al aterrizar, queda tendido de costado antes de levantarse
  // Umbral de altura para considerar a un jugador "en el aire" a efectos
  // de la colisión automática con el balón (salto, clavado, etc.).
  AIRBORNE_COLLISION_MIN_Y: 0.15,
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
  // llena sigue creciendo hasta KICK_POWER. Los tres segmentos +10%.
  KICK_POWER: 44, // velocidad a barra llena (charge = 1)
  KICK_MIN_SPEED: 0.792, // velocidad con la barra recién empezada (toque ~1 m)
  KICK_PIVOT_CHARGE: 0.2, // a partir de acá el remate ya "se siente"
  KICK_PIVOT_SPEED: 16.5, // velocidad en KICK_PIVOT_CHARGE
  KICK_LOW_CURVE: 2, // exponente del tramo [0, PIVOT]: ease-in suave (toque sigue siendo toque)
  KICK_CURVE: 1.15, // exponente del tramo [PIVOT, 1]: crecimiento sostenido hasta el máximo
  KICK_RANGE: 1.5,
  KICK_CHARGE_TIME_MS: 900,
  RECAPTURE_DELAY_MS: 450, // quien patea no re-captura su propio pase al instante
  // Altura del remate: depende SOLO de hacia dónde mira la cámara (pitch),
  // NUNCA de cuánto se cargó la barra — la potencia no debe determinar la
  // altura, eso lo dijiste explícitamente. En cambio, levantar el balón
  // SÍ le cuesta algo de velocidad horizontal (KICK_HORIZ_LIFT_PENALTY):
  // así la altura queda relacionada con la distancia/velocidad real, no
  // sumada gratis encima de la potencia completa — un remate a barra
  // llena apuntando al cielo llega más lejos que uno a media barra, pero
  // ambos suben lo MISMO si apuntan igual. Con la curva de potencia actual
  // (que ya sube rápido), esto hace que "media barra + buena cámara" dé un
  // centro corto y controlable, y barra llena dé un centro/pelotazo más
  // largo a la misma altura — sin necesitar cargar al máximo para un buen
  // centro, ni que un toque mínimo mande la pelota a upa como un cañonazo.
  KICK_LIFT_BASE: 0.4, // lift residual incluso mirando al piso (nunca 100% pegado)
  KICK_LIFT_PITCH_MAX: 9.5, // lift máximo por apuntar la cámara al cielo
  KICK_HORIZ_LIFT_PENALTY: 0.4, // fracción de velocidad horizontal que "cuesta" el lift máximo

  // Cruzar pie (clic ruedita): SIN cooldown — se puede spamear o cronometrar.
  // Controla/roba el balón si está dentro del área de control circular
  // alrededor del jugador (cualquier ángulo). Es la única forma de "recibir"
  // un balón libre (si no se usa, la pelota pasa entre las piernas).
  // NO cobra falta: si no toca el balón, no pasa nada. Si dos rivales
  // llegan en el mismo instante y ambos son elegibles, se define 50/50.
  EXTEND_DURATION_MS: 220, // dura poco pero se nota: metida de pie sutil
  CONTROL_AREA_RADIUS: 0.63, // círculo en la base del jugador (-30% del original 0.9)
  CONTROL_AREA_HEIGHT: 2.0, // cilindro de pies a cabeza: también controla balones que vienen volando

  // Barrida (clic derecho): si toca el balón, se lo queda pegado;
  // si contacta al rival, es falta. La velocidad real al iniciarla
  // (parado/trote/sprint) es el punto de partida del lunge, que después
  // frena solo por deceleración natural (SLIDE_DECEL) — parado apenas se
  // desliza, corriendo recorre unos metros según la velocidad previa.
  SLIDE_REACH: 1.45,
  SLIDE_DURATION_MS: 650,
  SLIDE_SPEED: 10.5, // techo histórico, ya no se usa como velocidad fija del lunge
  SLIDE_DECEL: 9, // frenado del lunge, m/s²
  SLIDE_COOLDOWN_MS: 2200,
  SLIDE_BODY_FOUL_RADIUS: 0.7, // contacto de cuerpo durante la barrida

  // Vuelo bajo (solo arquero): mismo gesto que la barrida pero lateral,
  // se dispara con barrida + A/D en vez de W/línea recta. SIN cooldown
  // (el cooldown es exclusivo de la barrida recta) — no controla ni cobra
  // falta, es una colisión de cuerpo automática contra el balón libre,
  // igual que la barrida pero hacia el costado; si el balón la toca, el
  // arquero se la queda atajada en las manos (igual que en el clavado alto).
  LOW_DIVE_SPEED: 7,
  LOW_DIVE_DURATION_MS: 550,

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
  DIVE: 9, // clavado lateral del arquero (en el aire)
  CATCH: 10, // arquero con el balón atajado en las manos
  LOW_DIVE: 11, // vuelo bajo del arquero (lateral, pegado al piso)
  DIVE_GROUND: 12, // arquero tendido de costado, recién aterrizado del clavado
};

export const TEAM_COLORS = [0xd63b3b, 0x2f6fd6]; // rojo vs azul
