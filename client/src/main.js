import * as THREE from 'three';
import { InputManager } from './core/InputManager.js';
import { NetworkClient } from './net/NetworkClient.js';
import { GameClient } from './game/GameClient.js';
import { HUD } from './ui/HUD.js';

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

const input = new InputManager(canvas);
const net = new NetworkClient();
const hud = new HUD();
const game = new GameClient({ scene, camera, input, net, hud });

// ---------------------------------------------------------------- unión

const joinScreen = document.getElementById('join-screen');
const joinForm = document.getElementById('join-form');
const joinError = document.getElementById('join-error');
const nicknameInput = document.getElementById('nickname');
const skinSelect = document.getElementById('skin-select');

// Selector de skin: la lista sale de /api/skins (los .png en
// client/assets/skins/, nombre de archivo = nombre de la skin).
const SKIN_STORAGE_KEY = 'sokkaio.skin';
fetch('/api/skins')
  .then((r) => r.json())
  .then((skins) => {
    if (!Array.isArray(skins) || skins.length === 0) return;
    const remembered = localStorage.getItem(SKIN_STORAGE_KEY);
    skinSelect.innerHTML = '';
    for (const name of skins) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      skinSelect.appendChild(opt);
    }
    if (remembered && skins.includes(remembered)) skinSelect.value = remembered;
  })
  .catch(() => {
    /* sin conexión al listado: se usa la skin por defecto del servidor */
  });

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nickname = nicknameInput.value.trim();
  if (!nickname) return;
  joinError.textContent = '';
  const skin = skinSelect.value || undefined;
  if (skin) localStorage.setItem(SKIN_STORAGE_KEY, skin);
  net.join(nickname, skin);
});

net.on('joinError', (msg) => {
  joinError.textContent = msg;
});

const prevJoined = net.handlers.joined;
net.on('joined', (data) => {
  prevJoined?.(data);
  joinScreen.classList.add('hidden');
  input.lock();
});
// GameClient registró 'joined' antes; reencadenamos para ocultar la pantalla.

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
});
