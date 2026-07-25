/** HUD: marcador, barra de stamina y mensajes efímeros. */
export class HUD {
  constructor() {
    this.root = document.getElementById('hud');
    this.scoreRed = document.getElementById('score-red');
    this.scoreBlue = document.getElementById('score-blue');
    this.staminaBar = document.getElementById('stamina-bar');
    this.messages = document.getElementById('messages');
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
