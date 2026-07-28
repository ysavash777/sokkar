import { PLAYER } from '/shared/constants.js';

/**
 * Sonidos del juego: trote (con/sin balón, en bucle, velocidad de
 * reproducción ligada a la velocidad real del jugador) y patada (one-shot,
 * para cualquier jugador que patee). Si los archivos de audio no están
 * presentes (client/assets/sounds/*.ogg), falla en silencio — no rompe el
 * juego, simplemente no suena hasta que se agreguen.
 */
const RATE_MIN = 0.75; // playbackRate al trote más lento perceptible
const RATE_MAX = 1.5; // playbackRate a sprint máximo
const FADE_SPEED = 0.08; // por debajo de esto (m/s) se considera "parado"

export class SoundManager {
  constructor() {
    this.run = this._makeLoop('/assets/sounds/run.ogg');
    this.ballRun = this._makeLoop('/assets/sounds/ballrun.ogg');
    this.shot = new Audio('/assets/sounds/shot.ogg');
    this.shot.volume = 0.8;
    this._active = null; // cuál de los dos loops está sonando ahora
  }

  _makeLoop(src) {
    const a = new Audio(src);
    a.loop = true;
    a.volume = 0.55;
    return a;
  }

  /**
   * Llamar cada frame con la velocidad real del jugador local y si tiene
   * el balón — sube y baja de tono en vivo según la velocidad, y cambia
   * entre run.ogg/ballrun.ogg sin cortar bruscamente (pausa el que no
   * corresponde, sigue el otro desde donde estaba la próxima vez).
   */
  updateFootsteps(speed, hasBall) {
    const track = hasBall ? this.ballRun : this.run;
    const other = hasBall ? this.run : this.ballRun;

    if (this._active && this._active !== track) {
      this._active.pause();
    }

    if (speed > FADE_SPEED) {
      const t = Math.min(1, speed / PLAYER.SPRINT_SPEED);
      track.playbackRate = RATE_MIN + (RATE_MAX - RATE_MIN) * t;
      if (track.paused) track.play().catch(() => {});
      this._active = track;
    } else {
      track.pause();
      other.pause();
      this._active = null;
    }
  }

  /** Patada de cualquier jugador (propia o de red) — se puede superponer. */
  playShot() {
    const s = this.shot.cloneNode(true);
    s.volume = this.shot.volume;
    s.play().catch(() => {});
  }
}
