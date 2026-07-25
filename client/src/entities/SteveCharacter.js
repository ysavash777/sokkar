import * as THREE from 'three';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/loaders/GLTFLoader.js';
import { ANIM, TEAM_COLORS } from '/shared/constants.js';

/**
 * Personaje "Steve" cargado desde un modelo .gltf hecho en Blockbench
 * (client/assets/steve.gltf), en vez de geometría armada a mano.
 * El rig trae 3 nodos raíz (Waist con cabeza/torso/brazos, y las dos
 * piernas como hermanos) con pivotes ya orientados por Blockbench en
 * cada articulación — los animamos aplicando una rotación adicional
 * sobre la pose base (quaternion) de cada pivote.
 */
const MODEL_URL = '/assets/steve.gltf';
const MODEL_SCALE = 0.9; // el rig mide ~2 unidades de alto -> ~1.8 (PLAYER.HEIGHT)
// La cara del modelo (ojos) quedó pintada mirando hacia -Z local, pero el
// juego usa +Z como "adelante" (yaw=0) — se corrige con un giro de 180°.
const FRONT_ROTATION_Y = Math.PI;

// Un solo material tintado por equipo, compartido entre todas las instancias
// (todas las mallas del glTF usan el mismo atlas de textura).
let templatePromise = null;
let teamMaterials = null;

function loadTemplate() {
  if (!templatePromise) {
    // GLTFLoader decodifica texturas con createImageBitmap, que en algunos
    // entornos falla para PNGs embebidos en base64 ("Couldn't load texture").
    // Cargamos la imagen aparte con TextureLoader (basado en <img>, más
    // compatible) y la reasignamos al material una vez lista.
    const texPromise = fetch(MODEL_URL)
      .then((r) => r.json())
      .then((data) => {
        const uri = data.images?.[0]?.uri;
        if (!uri) return null;
        return new THREE.TextureLoader().loadAsync(uri).then((tex) => {
          tex.flipY = false; // convención glTF (UV con origen arriba-izquierda)
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.magFilter = THREE.NearestFilter;
          tex.minFilter = THREE.NearestFilter;
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          return tex;
        });
      });

    templatePromise = Promise.all([new GLTFLoader().loadAsync(MODEL_URL), texPromise]).then(
      ([gltf, texture]) => {
        let sourceMat = null;
        gltf.scene.traverse((o) => {
          if (o.isMesh && !sourceMat) sourceMat = o.material;
        });
        if (texture) sourceMat.map = texture;
        sourceMat.needsUpdate = true;

        teamMaterials = TEAM_COLORS.map((hex) => {
          const m = sourceMat.clone();
          m.color = new THREE.Color(0xffffff).lerp(new THREE.Color(hex), 0.55);
          return m;
        });
        return gltf.scene;
      },
    );
  }
  return templatePromise;
}

const _xAxis = new THREE.Vector3(1, 0, 0);
const _qDelta = new THREE.Quaternion();

/** Aplica una rotación adicional sobre el eje X local, sobre la pose base del pivote. */
function poseLimb(node, angleX) {
  if (!node) return;
  node.quaternion.copy(node.userData.baseQuat).multiply(_qDelta.setFromAxisAngle(_xAxis, angleX));
  node.position.copy(node.userData.basePos);
}

export class SteveCharacter {
  constructor(team, nickname) {
    this.group = new THREE.Group();
    this.team = team;
    this.nickname = nickname;
    this.walkPhase = 0;
    this.animState = ANIM.IDLE;
    this.actionTimer = 0; // temporizador de kick/extend/slide
    this.ready = false;

    loadTemplate().then((template) => this._build(template));
  }

  _build(template) {
    const clone = template.clone(true);
    const mat = teamMaterials[this.team];
    clone.traverse((o) => {
      if (o.isMesh) {
        o.material = mat;
        o.frustumCulled = false;
      }
    });

    // Envuelve TODO (Waist + las dos piernas, que son hermanas en el rig)
    // para poder inclinar el cuerpo entero (barrida) o escalarlo de una vez.
    this.body = new THREE.Group();
    for (const child of [...clone.children]) this.body.add(child);
    this.body.scale.setScalar(MODEL_SCALE);
    this.body.rotation.y = FRONT_ROTATION_Y;
    this.group.add(this.body);

    // GLTFLoader sanitiza los nombres: espacios -> "_" y sufijo "_1" en
    // los hijos que colisionan con el nombre del contenedor pivote.
    this.armL = this.body.getObjectByName('Left_Arm');
    this.armR = this.body.getObjectByName('Right_Arm');
    this.legL = this.body.getObjectByName('Left_Leg');
    this.legR = this.body.getObjectByName('Right_Leg');

    for (const n of [this.armL, this.armR, this.legL, this.legR]) {
      if (!n) continue;
      n.userData.baseQuat = n.quaternion.clone();
      n.userData.basePos = n.position.clone();
    }

    this.nameSprite = this.makeNameSprite(this.nickname, this.team);
    this.group.add(this.nameSprite);

    this.ready = true;
  }

  makeNameSprite(text, team) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 34px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#' + TEAM_COLORS[team].toString(16).padStart(6, '0');
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 5;
    ctx.strokeText(text, 128, 42);
    ctx.fillText(text, 128, 42);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sprite.scale.set(2, 0.5, 1);
    sprite.position.y = 2.3;
    return sprite;
  }

  setAnim(state) {
    if (state === this.animState) return;
    this.animState = state;
    if (state === ANIM.KICK || state === ANIM.EXTEND || state === ANIM.SLIDE) {
      this.actionTimer = 0;
    }
  }

  /** Animación procedural: ciclo de caminata + poses de acción. */
  update(dt, horizontalSpeed) {
    if (!this.ready) return;
    this.actionTimer += dt;
    const s = this.animState;

    // Reset de pose base.
    this.body.rotation.x = 0;
    this.body.position.y = 0;

    if (s === ANIM.SLIDE) {
      // Barrida: cuerpo reclinado, pierna derecha extendida al frente.
      this.body.rotation.x = -0.95;
      this.body.position.y = -0.32;
      poseLimb(this.legR, -1.3);
      poseLimb(this.legL, 0.35);
      poseLimb(this.armL, 0.8);
      poseLimb(this.armR, 0.8);
      return;
    }

    if (s === ANIM.KICK) {
      // Patada rápida con la derecha (~0.3 s de swing).
      const t = Math.min(this.actionTimer / 0.3, 1);
      poseLimb(this.legR, -Math.sin(t * Math.PI) * 1.5);
      poseLimb(this.legL, 0.2);
      poseLimb(this.armL, -0.5);
      poseLimb(this.armR, 0.5);
      return;
    }

    if (s === ANIM.EXTEND) {
      // Cruzar pie: extensión defensiva corta del pie derecho.
      poseLimb(this.legR, -0.9);
      if (this.legR) this.legR.position.z += 0.12;
      poseLimb(this.legL, 0.15);
      poseLimb(this.armL, 0.3);
      poseLimb(this.armR, -0.3);
      return;
    }

    if (s === ANIM.STUNNED) {
      this.body.rotation.x = 0.25;
      poseLimb(this.armL, 0.6);
      poseLimb(this.armR, 0.6);
      poseLimb(this.legL, 0);
      poseLimb(this.legR, 0);
      return;
    }

    if (s === ANIM.JUMP) {
      poseLimb(this.legL, 0.5);
      poseLimb(this.legR, -0.5);
      poseLimb(this.armL, -2.6);
      poseLimb(this.armR, -2.6);
      return;
    }

    // Ciclo de caminata/carrera según velocidad real.
    const speedNorm = Math.min(horizontalSpeed / 7, 1.15);
    this.walkPhase += dt * (4 + horizontalSpeed * 1.7);
    const swing = Math.sin(this.walkPhase) * 0.85 * speedNorm;
    poseLimb(this.legL, swing);
    poseLimb(this.legR, -swing);
    poseLimb(this.armL, -swing * 0.8);
    poseLimb(this.armR, swing * 0.8);
  }

  dispose() {
    if (this.nameSprite) {
      this.nameSprite.material.map.dispose();
      this.nameSprite.material.dispose();
    }
    this.group.removeFromParent();
  }
}
