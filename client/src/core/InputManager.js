/**
 * Captura teclado + mouse con pointer lock.
 * Mapa: WASD mover, Shift sprint, Espacio salto,
 * clic izq patear, clic rueda cruzar pie, clic der barrida.
 */
export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.kickHeld = false; // clic izq mantenido = cargando remate
    // Acciones one-shot que el game loop consume.
    this.queued = { kickRelease: false, extend: false, slide: false, jump: false };

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

  get moveAxis() {
    let x = 0;
    let z = 0;
    if (this.keys.has('KeyW')) z += 1;
    if (this.keys.has('KeyS')) z -= 1;
    if (this.keys.has('KeyA')) x -= 1;
    if (this.keys.has('KeyD')) x += 1;
    return { x, z };
  }

  get sprint() {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }
}
