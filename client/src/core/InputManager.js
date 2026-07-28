/**
 * Captura teclado + mouse (con pointer lock) y, en móvil, los controles
 * táctiles virtuales (ver mobile/MobileControls.js). Mapa desktop: WASD
 * mover, Shift sprint, Espacio salto, clic izq patear, clic rueda cruzar
 * pie, clic der barrida. Ambas fuentes escriben al mismo estado interno,
 * así que el resto del juego (GameClient) no distingue de dónde vino
 * cada input.
 */
// Tope por evento individual de movementX/Y — ver el listener de
// 'mousemove' más abajo.
const MAX_MOUSE_DELTA_PER_EVENT = 250;

export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.kickHeld = false; // clic izq mantenido = cargando remate
    // Acciones one-shot que el game loop consume.
    this.queued = { kickRelease: false, extend: false, slide: false, jump: false };

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
        this._lockPointer();
        return;
      }
      if (e.button === 0) this.kickHeld = true;
      else if (e.button === 1) this.queued.extend = true;
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
      // Guarda defensiva: un solo evento con un delta absurdo (glitch de
      // driver/navegador, p.ej. al recién adquirir el pointer lock) no debe
      // traducirse en un salto brusco de cámara — un giro rápido normal
      // nunca llega a este límite por evento individual (el polling del
      // mouse entrega muchos eventos por frame, cada uno con un delta
      // razonable), así que esto no frena giros rápidos genuinos.
      const dx = Math.max(-MAX_MOUSE_DELTA_PER_EVENT, Math.min(MAX_MOUSE_DELTA_PER_EVENT, e.movementX));
      const dy = Math.max(-MAX_MOUSE_DELTA_PER_EVENT, Math.min(MAX_MOUSE_DELTA_PER_EVENT, e.movementY));
      this.mouseDX += dx;
      this.mouseDY += dy;
    });
  }

  /**
   * Pide el movimiento CRUDO del dispositivo (unadjustedMovement), sin la
   * curva de aceleración de puntero del sistema operativo — esa curva es
   * no lineal y se nota más cuanto más rápido se mueve el mouse, lo que se
   * sentía como que la cámara "se pierde y se reajusta" al girar rápido en
   * 360. No todos los navegadores la soportan: si el navegador la soporta
   * pero la rechaza (o directamente no expone la Promise, API vieja), cae
   * de nuevo al pointer lock normal sin romper nada.
   */
  _lockPointer() {
    const result = this.canvas.requestPointerLock?.({ unadjustedMovement: true });
    if (result && typeof result.catch === 'function') {
      result.catch(() => this.canvas.requestPointerLock?.());
    }
  }

  lock() {
    this._lockPointer();
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
