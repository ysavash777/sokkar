import * as THREE from 'three';
import { PLAYER } from '/shared/constants.js';
import { InputManager } from './core/InputManager.js';
import { NetworkClient } from './net/NetworkClient.js';
import { GameClient } from './game/GameClient.js';
import { HUD } from './ui/HUD.js';
import { MobileControls, isMobileDevice } from './mobile/MobileControls.js';

/**
 * Punto de entrada: renderer optimizado, escena, bucle principal
 * y flujo de conexión (nickname -> partida).
 */
const canvas = document.getElementById('game');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
// Cap del pixel ratio: en pantallas 4K/retina evita render gigante (anti-lag).
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b7e8);
scene.fog = new THREE.Fog(0x87b7e8, 60, 140);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 8, -14);

// Iluminación barata: hemisferio + una direccional SIN sombras (anti-lag).
scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x3a5f3a, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(20, 40, 10);
scene.add(sun);

// Depuración de la asistencia de atajada del arquero (esfera roja
// translúcida, ver PLAYER.DIVE_CATCH_SPHERE_RADIUS): NO forma parte del
// juego normal, solo se activa a propósito con ?debug=1 en la URL.
window.SOKKAIO_DEBUG = new URLSearchParams(location.search).get('debug') === '1';

const input = new InputManager(canvas);
const net = new NetworkClient();
const hud = new HUD();
const game = new GameClient({ scene, camera, input, net, hud });

// En móvil: joystick + botones táctiles en vez de teclado/mouse, y no se
// usa pointer lock (la cámara se mueve arrastrando el dedo, ver
// MobileControls). document.body marca ".is-mobile" para adaptar el CSS
// (p.ej. ocultar la ayuda de controles de escritorio en la pantalla de ingreso).
const mobile = isMobileDevice();
let mobileControls = null;
if (mobile) {
  document.body.classList.add('is-mobile');
  mobileControls = new MobileControls(input, canvas);
  // Ocultos hasta unirse a la partida: en la pantalla de nickname no hay
  // nada que mover ni patear todavía (ver net.on('joined') más abajo).
  mobileControls.root.classList.add('hidden');
}

// ---------------------------------------------------------------- unión

const joinScreen = document.getElementById('join-screen');
const joinForm = document.getElementById('join-form');
const joinError = document.getElementById('join-error');
const nicknameInput = document.getElementById('nickname');
const skinSelect = document.getElementById('skin-select');
const positionSelect = document.getElementById('position-select');

// Selector de skin: la lista sale de /api/skins (los .png en
// client/assets/skins/, nombre de archivo = nombre de la skin). Se usa
// tanto para la pantalla de ingreso como para el panel de personalización
// en partida (loadout-skin) — misma lista, sin pedirla dos veces.
const SKIN_STORAGE_KEY = 'sokkaio.skin';
const loadoutSkinSelect = document.getElementById('loadout-skin');
fetch('/api/skins')
  .then((r) => r.json())
  .then((skins) => {
    if (!Array.isArray(skins) || skins.length === 0) return;
    const remembered = localStorage.getItem(SKIN_STORAGE_KEY);
    for (const select of [skinSelect, loadoutSkinSelect]) {
      select.innerHTML = '';
      for (const name of skins) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
      }
      if (remembered && skins.includes(remembered)) select.value = remembered;
    }
  })
  .catch(() => {
    /* sin conexión al listado: se usa la skin por defecto del servidor */
  });

let lastJoinedSkin; // el 'joined' del servidor no devuelve la skin — se recuerda lo que se envió
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nickname = nicknameInput.value.trim();
  if (!nickname) return;
  joinError.textContent = '';
  const skin = skinSelect.value || undefined;
  if (skin) localStorage.setItem(SKIN_STORAGE_KEY, skin);
  lastJoinedSkin = skin;
  net.join(nickname, skin, positionSelect.value);
});

net.on('joinError', (msg) => {
  joinError.textContent = msg;
});

// -------------------------------------------------- personalización en partida

const loadoutBtn = document.getElementById('loadout-btn');
const loadoutPanel = document.getElementById('loadout-panel');
const loadoutPositionSelect = document.getElementById('loadout-position');
const loadoutSensSection = document.getElementById('loadout-sens-section');
const loadoutSensFree = document.getElementById('loadout-sens-free');
const loadoutSensAim = document.getElementById('loadout-sens-aim');
const loadoutSensFreeVal = document.getElementById('loadout-sens-free-val');
const loadoutSensAimVal = document.getElementById('loadout-sens-aim-val');

const prevJoined = net.handlers.joined;
net.on('joined', (data) => {
  prevJoined?.(data);
  joinScreen.classList.add('hidden');
  if (!mobile) input.lock(); // pointer lock es cosa de mouse; en móvil no aplica
  if (mobileControls) mobileControls.root.classList.remove('hidden'); // recién ahora hay algo que controlar
  loadoutSkinSelect.value = lastJoinedSkin || skinSelect.value;
  loadoutPositionSelect.value = data.position || 'FIELD';
});
// GameClient registró 'joined' antes; reencadenamos para ocultar la pantalla.

loadoutBtn.addEventListener('click', () => {
  // La sensibilidad Free/Aim solo aplica en móvil (deslizar la pantalla) —
  // en PC la sensibilidad del mouse no depende de este panel.
  loadoutSensSection.classList.toggle('hidden', !mobileControls);
  if (mobileControls) {
    loadoutSensFree.value = mobileControls.prefs.sensFree;
    loadoutSensAim.value = mobileControls.prefs.sensAim;
    loadoutSensFreeVal.textContent = mobileControls.prefs.sensFree.toFixed(2);
    loadoutSensAimVal.textContent = mobileControls.prefs.sensAim.toFixed(2);
  }
  loadoutPanel.classList.remove('hidden');
});
document.getElementById('loadout-close-btn').addEventListener('click', () => {
  loadoutPanel.classList.add('hidden');
});
document.getElementById('loadout-apply-btn').addEventListener('click', () => {
  const skin = loadoutSkinSelect.value || undefined;
  const position = loadoutPositionSelect.value;
  if (skin) localStorage.setItem(SKIN_STORAGE_KEY, skin);
  net.changeLoadout(skin, position);
  if (mobileControls) {
    mobileControls.prefs.sensFree = +loadoutSensFree.value;
    mobileControls.prefs.sensAim = +loadoutSensAim.value;
    mobileControls._save('sokkaio.touchControls.prefs', mobileControls.prefs);
  }
  loadoutPanel.classList.add('hidden');
});
loadoutSensFree.addEventListener('input', () => {
  loadoutSensFreeVal.textContent = (+loadoutSensFree.value).toFixed(2);
});
loadoutSensAim.addEventListener('input', () => {
  loadoutSensAimVal.textContent = (+loadoutSensAim.value).toFixed(2);
});

// ---------------------------------------------------------------- loop

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Handle de depuración (consola del navegador).
window.sokkaio = { game, net, input, renderer, scene, camera };

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  game.update(dt);
  renderer.render(scene, camera);
  // Sprint táctil: se apaga solo si la stamina real ya no alcanza (y se
  // reactiva cuando vuelve a haber suficiente), en vez de dejarlo
  // "prendido" sin efecto.
  if (mobileControls && game.myId) {
    mobileControls.updateSprintAvailability(game.local.stamina > PLAYER.STAMINA_MIN_TO_SPRINT);
  }
});
