/**
 * Controles táctiles para móvil: joystick virtual + botones de acción,
 * botón de pantalla completa y un modo de edición para mover, escalar y
 * cambiar la opacidad de todo el set. Todo se traduce al mismo
 * InputManager que usa el teclado/mouse (ver setTouchAxis/trigger/etc.),
 * así que GameClient no distingue el origen del input.
 */
const STORAGE_LAYOUT_KEY = 'sokkaio.touchControls.layout';
const STORAGE_PREFS_KEY = 'sokkaio.touchControls.prefs';

// Posiciones por defecto: centro de cada control, en % del viewport.
const DEFAULT_LAYOUT = {
  joystick: { xPct: 16, yPct: 78 },
  kick: { xPct: 86, yPct: 68 },
  extend: { xPct: 68, yPct: 88 },
  slide: { xPct: 92, yPct: 88 },
  jump: { xPct: 68, yPct: 58 },
  sprint: { xPct: 92, yPct: 58 },
};
// sensFree: sensibilidad de cámara al deslizar normalmente. sensAim:
// sensibilidad SOLO mientras se mantiene el botón de remate (apuntado más
// fino) — ver _bindLookLayer.
const DEFAULT_PREFS = { scale: 1, opacity: 0.75, sensFree: 1, sensAim: 0.6 };

const BUTTONS = [
  { id: 'kick', label: '⚽', kind: 'kick', big: true },
  { id: 'extend', label: 'PIE', kind: 'tap' },
  { id: 'slide', label: 'BAR', kind: 'tap' },
  { id: 'jump', label: 'SALTO', kind: 'tap' },
  { id: 'sprint', label: 'SPR', kind: 'toggle' },
];

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/** Móvil = soporta touch Y el puntero primario es "coarse" (dedo, no mouse). */
export function isMobileDevice() {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  return touch && coarse;
}

export class MobileControls {
  constructor(input, canvas) {
    this.input = input;
    this.canvas = canvas;
    this.editMode = false;
    this.layout = this._load(STORAGE_LAYOUT_KEY, DEFAULT_LAYOUT);
    this.prefs = this._load(STORAGE_PREFS_KEY, DEFAULT_PREFS);
    this.buttons = {};

    this.root = document.createElement('div');
    this.root.id = 'touch-controls';
    document.body.appendChild(this.root);

    canvas.style.touchAction = 'none';

    this._buildCornerButtons();
    this._buildSettingsPanel();
    this._buildJoystick();
    this._buildActionButtons();
    this._bindLookLayer();
    this._applyPrefs();
  }

  // ---------------------------------------------------------------- layout

  _load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
    } catch {
      return { ...fallback };
    }
  }

  _save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* localStorage no disponible (modo privado, etc.) — se pierde entre sesiones */
    }
  }

  _positionControl(el, key) {
    const pos = this.layout[key] || DEFAULT_LAYOUT[key];
    el.style.left = `${pos.xPct}%`;
    el.style.top = `${pos.yPct}%`;
  }

  _applyPrefs() {
    this.root.style.setProperty('--touch-scale', this.prefs.scale);
    this.root.style.setProperty('--touch-opacity', this.prefs.opacity);
  }

  /** En modo edición, arrastrar el control lo reposiciona y lo guarda. */
  _makeDraggable(el, key) {
    let touchId = null;
    el.addEventListener(
      'touchstart',
      (e) => {
        if (!this.editMode) return;
        e.preventDefault();
        e.stopPropagation();
        touchId = e.changedTouches[0].identifier;
      },
      { passive: false },
    );
    el.addEventListener(
      'touchmove',
      (e) => {
        if (!this.editMode || touchId === null) return;
        e.preventDefault();
        e.stopPropagation();
        for (const t of e.changedTouches) {
          if (t.identifier !== touchId) continue;
          const xPct = clamp((t.clientX / window.innerWidth) * 100, 6, 94);
          const yPct = clamp((t.clientY / window.innerHeight) * 100, 8, 94);
          this.layout[key] = { xPct, yPct };
          el.style.left = `${xPct}%`;
          el.style.top = `${yPct}%`;
        }
      },
      { passive: false },
    );
    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === touchId) touchId = null;
      }
      this._save(STORAGE_LAYOUT_KEY, this.layout);
    };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
  }

  // ------------------------------------------------------------- controles

  _buildCornerButtons() {
    const fullscreenBtn = document.createElement('button');
    fullscreenBtn.id = 'touch-fullscreen-btn';
    fullscreenBtn.className = 'touch-corner-btn';
    fullscreenBtn.textContent = '⛶';
    fullscreenBtn.title = 'Pantalla completa';
    fullscreenBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.().catch(() => {});
    });
    this.root.appendChild(fullscreenBtn);

    const editBtn = document.createElement('button');
    editBtn.id = 'touch-edit-btn';
    editBtn.className = 'touch-corner-btn';
    editBtn.textContent = '⚙';
    editBtn.title = 'Configurar controles';
    editBtn.addEventListener('click', () => this._setEditMode(!this.editMode));
    this.root.appendChild(editBtn);
  }

  _buildSettingsPanel() {
    const panel = document.createElement('div');
    panel.id = 'touch-settings-panel';
    panel.className = 'hidden';
    panel.innerHTML = `
      <p class="touch-settings-title">Controles táctiles</p>
      <p class="touch-settings-hint">Arrastrá cada control para moverlo</p>
      <label>Tamaño
        <input type="range" id="touch-scale" min="0.7" max="1.5" step="0.05" />
      </label>
      <label>Opacidad
        <input type="range" id="touch-opacity" min="0.3" max="1" step="0.05" />
      </label>
      <label>Sensibilidad libre
        <input type="range" id="touch-sens-free" min="0.3" max="2.5" step="0.05" />
      </label>
      <label>Sensibilidad apuntando
        <input type="range" id="touch-sens-aim" min="0.3" max="2.5" step="0.05" />
      </label>
      <div class="touch-settings-actions">
        <button type="button" id="touch-reset-btn">Restablecer</button>
        <button type="button" id="touch-done-btn">Listo</button>
      </div>
    `;
    this.root.appendChild(panel);
    this.settingsPanel = panel;

    const scaleInput = panel.querySelector('#touch-scale');
    const opacityInput = panel.querySelector('#touch-opacity');
    const sensFreeInput = panel.querySelector('#touch-sens-free');
    const sensAimInput = panel.querySelector('#touch-sens-aim');
    scaleInput.value = this.prefs.scale;
    opacityInput.value = this.prefs.opacity;
    sensFreeInput.value = this.prefs.sensFree;
    sensAimInput.value = this.prefs.sensAim;
    scaleInput.addEventListener('input', () => {
      this.prefs.scale = +scaleInput.value;
      this._applyPrefs();
      this._save(STORAGE_PREFS_KEY, this.prefs);
    });
    opacityInput.addEventListener('input', () => {
      this.prefs.opacity = +opacityInput.value;
      this._applyPrefs();
      this._save(STORAGE_PREFS_KEY, this.prefs);
    });
    sensFreeInput.addEventListener('input', () => {
      this.prefs.sensFree = +sensFreeInput.value;
      this._save(STORAGE_PREFS_KEY, this.prefs);
    });
    sensAimInput.addEventListener('input', () => {
      this.prefs.sensAim = +sensAimInput.value;
      this._save(STORAGE_PREFS_KEY, this.prefs);
    });

    panel.querySelector('#touch-reset-btn').addEventListener('click', () => {
      this.layout = { ...DEFAULT_LAYOUT };
      this._positionControl(this.joystickEl, 'joystick');
      for (const id of Object.keys(this.buttons)) this._positionControl(this.buttons[id], id);
      this._save(STORAGE_LAYOUT_KEY, this.layout);
    });
    panel.querySelector('#touch-done-btn').addEventListener('click', () => this._setEditMode(false));
  }

  _setEditMode(on) {
    this.editMode = on;
    this.root.classList.toggle('edit-mode', on);
    this.settingsPanel.classList.toggle('hidden', !on);
    // Nada de joystick/botones activos mientras se editan posiciones.
    this.input.setTouchAxis(null);
    this.input.setKickHeld(false);
  }

  /**
   * Llamado cada frame desde afuera (main.js) con si el jugador tiene
   * stamina suficiente para sprintar. Sin stamina: apaga el toggle solo
   * (aunque siga tocado) y bloquea reintentos hasta recuperarse.
   */
  updateSprintAvailability(available) {
    const btn = this.buttons.sprint;
    if (!btn) return;
    if (!available) {
      if (!btn.classList.contains('unavailable')) {
        btn.classList.remove('toggled', 'active');
        btn.classList.add('unavailable');
        this.input.setTouchSprint(false);
      }
    } else {
      btn.classList.remove('unavailable');
    }
  }

  _buildJoystick() {
    const base = document.createElement('div');
    base.id = 'touch-joystick';
    base.className = 'touch-joystick-base';
    const stick = document.createElement('div');
    stick.className = 'touch-joystick-stick';
    base.appendChild(stick);
    this.root.appendChild(base);
    this.joystickEl = base;
    this._positionControl(base, 'joystick');
    this._makeDraggable(base, 'joystick');

    const MAX_RADIUS = 34; // px — debe coincidir con el tamaño en CSS
    let touchId = null;
    let centerX = 0;
    let centerY = 0;

    const resetStick = () => {
      stick.style.transform = 'translate(-50%, -50%)';
    };

    base.addEventListener(
      'touchstart',
      (e) => {
        if (this.editMode || touchId !== null) return;
        e.preventDefault();
        e.stopPropagation();
        const t = e.changedTouches[0];
        touchId = t.identifier;
        const rect = base.getBoundingClientRect();
        centerX = rect.left + rect.width / 2;
        centerY = rect.top + rect.height / 2;
      },
      { passive: false },
    );

    base.addEventListener(
      'touchmove',
      (e) => {
        if (touchId === null) return;
        e.preventDefault();
        e.stopPropagation();
        for (const t of e.changedTouches) {
          if (t.identifier !== touchId) continue;
          let dx = t.clientX - centerX;
          let dy = t.clientY - centerY;
          const dist = Math.hypot(dx, dy);
          if (dist > MAX_RADIUS) {
            dx = (dx / dist) * MAX_RADIUS;
            dy = (dy / dist) * MAX_RADIUS;
          }
          stick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
          this.input.setTouchAxis({ x: dx / MAX_RADIUS, z: -dy / MAX_RADIUS });
        }
      },
      { passive: false },
    );

    const endTouch = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== touchId) continue;
        touchId = null;
        resetStick();
        this.input.setTouchAxis(null);
      }
    };
    base.addEventListener('touchend', endTouch);
    base.addEventListener('touchcancel', endTouch);
  }

  _buildActionButtons() {
    for (const def of BUTTONS) {
      const btn = document.createElement('div');
      btn.id = `touch-btn-${def.id}`;
      btn.className = `touch-btn${def.big ? ' touch-btn-big' : ''}`;
      btn.textContent = def.label;
      this.root.appendChild(btn);
      this._positionControl(btn, def.id);
      this._makeDraggable(btn, def.id);
      this._wireButton(btn, def);
      this.buttons[def.id] = btn;
    }
  }

  _wireButton(btn, def) {
    const onDown = (e) => {
      if (this.editMode) return;
      // Sprint sin stamina: el botón se apaga solo (ver
      // updateSprintAvailability) y no responde hasta recuperarse — sin
      // esto el jugador podía "reintentar" tocándolo igual.
      if (def.id === 'sprint' && btn.classList.contains('unavailable')) return;
      e.preventDefault();
      e.stopPropagation();
      btn.classList.add('active');
      if (def.kind === 'kick') this.input.setKickHeld(true);
      else if (def.kind === 'tap') this.input.trigger(def.id);
      else if (def.kind === 'toggle') {
        const next = !btn.classList.contains('toggled');
        btn.classList.toggle('toggled', next);
        this.input.setTouchSprint(next);
      }
    };
    const onUp = (e) => {
      if (this.editMode) return;
      e.preventDefault();
      btn.classList.remove('active');
      if (def.kind === 'kick') this.input.setKickHeld(false);
    };
    btn.addEventListener('touchstart', onDown, { passive: false });
    btn.addEventListener('touchend', onUp, { passive: false });
    btn.addEventListener('touchcancel', onUp, { passive: false });
  }

  /**
   * Arrastrar sobre el resto de la pantalla mueve la cámara (equivalente
   * al mouse) — con un dedo INDEPENDIENTE del que sostiene cualquier
   * botón (identifiers de touch distintos), así que apuntar mientras se
   * carga el remate funciona igual que soltar la carga en cualquier otro
   * momento: no hay nada que lo bloquee.
   */
  _bindLookLayer() {
    let touchId = null;
    let lastX = 0;
    let lastY = 0;

    this.canvas.addEventListener(
      'touchstart',
      (e) => {
        if (this.editMode || touchId !== null) return;
        const t = e.changedTouches[0];
        touchId = t.identifier;
        lastX = t.clientX;
        lastY = t.clientY;
      },
      { passive: true },
    );

    window.addEventListener(
      'touchmove',
      (e) => {
        if (touchId === null) return;
        for (const t of e.changedTouches) {
          if (t.identifier !== touchId) continue;
          // Sensibilidad "Aim" mientras se mantiene el botón de remate
          // (apuntado más fino), "Free" el resto del tiempo — ajustables
          // por separado desde el panel de ajustes.
          const mult = this.input.kickHeld ? this.prefs.sensAim : this.prefs.sensFree;
          this.input.addLookDelta((t.clientX - lastX) * mult, (t.clientY - lastY) * mult);
          lastX = t.clientX;
          lastY = t.clientY;
        }
      },
      { passive: true },
    );

    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === touchId) touchId = null;
      }
    };
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
  }
}
