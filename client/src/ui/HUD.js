/** HUD: marcador, barra de stamina y mensajes efímeros. */
export class HUD {
  constructor() {
    this.root = document.getElementById('hud');
    this.scoreRed = document.getElementById('score-red');
    this.scoreBlue = document.getElementById('score-blue');
    this.staminaBar = document.getElementById('stamina-bar');
    this.powerWrap = document.getElementById('power-wrap');
    this.powerBar = document.getElementById('power-bar');
    this.messages = document.getElementById('messages');
  }

  /** frac 0..1 mientras se carga el remate; null la oculta. */
  setPower(frac) {
    if (frac === null) {
      this.powerWrap.classList.add('hidden');
      return;
    }
    this.powerWrap.classList.remove('hidden');
    this.powerBar.style.width = `${Math.round(frac * 100)}%`;
  }

  show() {
    this.root.classList.remove('hidden');
  }

  setScore(score) {
    this.scoreRed.textContent = score[0];
    this.scoreBlue.textContent = score[1];
  }

  setStamina(frac) {
    this.staminaBar.style.width = `${Math.round(frac * 100)}%`;
  }

  message(text, kind = '') {
    const el = document.createElement('div');
    el.className = `msg ${kind}`;
    el.textContent = text;
    this.messages.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
}
