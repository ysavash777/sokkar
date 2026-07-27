/**
 * Captura teclado + mouse (con pointer lock) y, en móvil, los controles
 * táctiles virtuales (ver mobile/MobileControls.js). Mapa desktop: WASD
 * mover, Shift sprint, Espacio salto, clic izq patear, clic rueda cruzar
 * pie, clic der barrida. Ambas fuentes escriben al mismo estado interno,
 * así que el resto del juego (GameClient) no distingue de dónde vino
 * cada input.
 */
export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.kickHeld = false; // clic izq mantenido = cargando remate
    // Acciones one-shot que el game loop consume. kickPress marca el
    // FLANCO de bajada del clic izq (se dispara una sola vez al presionar,
    // a diferencia de kickHeld que se mantiene) — lo usa el arquero para
    // el clavado (ver GameClient), sin interferir con la carga del remate.
    this.queued = { kickRelease: false, kickPress: false, extend: false, slide: false, jump: false };

    // Override táctil del eje de movimiento (joystick virtual). Cuando
    // está activo reemplaza a WASD; se desactiva solo al soltar el stick.
    this.touchAxis = null; // { x, z } en [-1, 1] o null (sin joystick activo)
    this.touchSprint = false; // botón de sprint táctil (toggle)

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        this.queued.jump = true;
        e.preventDefault();
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (document.pointerLockElement !== canvas) {
        canvas.requestPointerLock();
        return;
      }
      if (e.button === 0) {
        this.kickHeld = true;
        this.queued.kickPress = true;
      } else if (e.button === 1) this.queued.extend = true;
      else if (e.button === 2) this.queued.slide = true;
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0 && this.kickHeld) {
        this.kickHeld = false;
        this.queued.kickRelease = true;
      }
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // El clic de rueda dispara auxclick/autoscroll en algunos navegadores.
    canvas.addEventListener('auxclick', (e) => e.preventDefault());

    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
  }

  lock() {
    this.canvas.requestPointerLock?.();
  }

  /** Devuelve y resetea el delta de mouse acumulado del frame. */
  consumeMouseDelta() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  /** Devuelve y limpia una acción one-shot. */
  consume(action) {
    const v = this.queued[action];
    this.queued[action] = false;
    return v;
  }

  // ---------------------------------------------------------- entrada táctil

  /** Joystick virtual: x/z en [-1, 1], o null para soltarlo (vuelve a WASD). */
  setTouchAxis(axis) {
    this.touchAxis = axis;
  }

  /** Botones virtuales: mismo canal que el teclado/mouse (one-shot). */
  trigger(action) {
    this.queued[action] = true;
  }

  setKickHeld(held) {
    if (!this.kickHeld && held) this.queued.kickPress = true;
    if (this.kickHeld && !held) this.queued.kickRelease = true;
    this.kickHeld = held;
  }

  setTouchSprint(held) {
    this.touchSprint = held;
  }

  /** Arrastre de dedo para mirar (equivalente táctil de movementX/Y del mouse). */
  addLookDelta(dx, dy) {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  get moveAxis() {
    if (this.touchAxis) return this.touchAxis;
    let x = 0;
    let z = 0;
    if (this.keys.has('KeyW')) z += 1;
    if (this.keys.has('KeyS')) z -= 1;
    if (this.keys.has('KeyA')) x -= 1;
    if (this.keys.has('KeyD')) x += 1;
    return { x, z };
  }

  get sprint() {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchSprint;
  }
}
