import * as THREE from 'three';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/utils/SkeletonUtils.js';
import { ANIM, TEAM_COLORS } from '/shared/constants.js';

/**
 * Personaje "Steve" cargado desde un modelo .gltf hecho en Blockbench
 * (client/assets/steve.gltf, pose neutral), en vez de geometría a mano.
 * El export viene CON SKINNING: los meshes son SkinnedMesh y cada parte
 * (Head, Body, Right/Left Arm, Right/Left Leg) es un HUESO con pivote en
 * su articulación — la animación procedural rota esos huesos. Por eso las
 * instancias se clonan con SkeletonUtils.clone (un Object3D.clone normal
 * no rebindea el esqueleto y el modelo renderiza descolocado).
 *
 * Skins: la textura NO se toma del glTF sino de /assets/skins/<nombre>.png
 * — el nombre del archivo es el nombre de la skin en juego, con lo cual
 * basta soltar más PNGs en esa carpeta para agregar skins.
 */
const MODEL_URL = '/assets/steve.gltf';
export const DEFAULT_SKIN = 'steve';
const MODEL_SCALE = 0.9; // el rig mide ~2 unidades de alto -> ~1.8 (PLAYER.HEIGHT)
// La cara del modelo (ojos) está pintada mirando hacia -Z local, pero el
// juego usa +Z como "adelante" (yaw=0) — se corrige con un giro de 180°.
// (Verificado mapeando la región UV de la cara frontal contra las normales.)
const FRONT_ROTATION_Y = Math.PI;

// Geometría del rig: se descarga y clona una sola vez (independiente de
// la skin). Se guarda también el material "base" del glTF (alphaTest,
// side, etc.) como plantilla para clonar el material de cada skin.
let templatePromise = null;
let baseMaterial = null;

function loadTemplate() {
  if (!templatePromise) {
    templatePromise = new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => {
      gltf.scene.traverse((o) => {
        if (o.isMesh && !baseMaterial) baseMaterial = o.material;
      });
      return gltf.scene;
    });
  }
  return templatePromise;
}

// 2 materiales (uno por equipo) por cada skin cargada, compartidos entre
// todas las instancias que usen esa skin — nombre de archivo = nombre de
// la skin en juego (client/assets/skins/<nombre>.png).
const skinMaterialsCache = new Map(); // skinName -> Promise<[matTeam0, matTeam1]>

function loadSkinMaterials(skinName) {
  if (!skinMaterialsCache.has(skinName)) {
    const promise = Promise.all([loadTemplate(), loadSkinTexture(skinName)]).then(([, texture]) => {
      return TEAM_COLORS.map((hex) => {
        const m = baseMaterial.clone();
        if (texture) m.map = texture;
        m.color = new THREE.Color(0xffffff).lerp(new THREE.Color(hex), 0.55);
        m.needsUpdate = true;
        return m;
      });
    });
    skinMaterialsCache.set(skinName, promise);
  }
  return skinMaterialsCache.get(skinName);
}

function loadSkinTexture(skinName) {
  // TextureLoader (basado en <img>) en vez de dejar que GLTFLoader use
  // createImageBitmap para el PNG embebido, que falla en algunos entornos.
  return new THREE.TextureLoader()
    .loadAsync(`/assets/skins/${skinName}.png`)
    .then((tex) => {
      tex.flipY = false; // convención glTF (UV con origen arriba-izquierda)
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      return tex;
    })
    .catch(() => null);
}

const _xAxis = new THREE.Vector3(1, 0, 0);
const _qDelta = new THREE.Quaternion();
const _groundBox = new THREE.Box3();

/** Aplica una rotación adicional sobre el eje X local, sobre la pose base del pivote. */
function poseLimb(node, angleX) {
  if (!node) return;
  node.quaternion.copy(node.userData.baseQuat).multiply(_qDelta.setFromAxisAngle(_xAxis, angleX));
  node.position.copy(node.userData.basePos);
}

export class SteveCharacter {
  constructor(team, nickname, skin = DEFAULT_SKIN, position = 'FIELD') {
    this.group = new THREE.Group();
    this.team = team;
    this.nickname = nickname;
    this.skin = skin || DEFAULT_SKIN;
    this.position = position === 'GK' ? 'GK' : 'FIELD';
    this.walkPhase = 0;
    this.animState = ANIM.IDLE;
    this.actionTimer = 0; // temporizador de kick/slide
    this.ready = false;
    this._prevPos = null;
    this._diveSide = 1; // lado real del vuelo (arquero), derivado del movimiento

    Promise.all([loadTemplate(), loadSkinMaterials(this.skin)]).then(([template, mats]) =>
      this._build(template, mats[this.team]),
    );
  }

  _build(template, mat) {
    // SkeletonUtils.clone: rebindea los SkinnedMesh al esqueleto clonado.
    const clone = skeletonClone(template);
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

    // Las extremidades son HUESOS del esqueleto, con el pivote en la
    // articulación (GLTFLoader sanitiza nombres: espacios -> "_" y puede
    // sufijar duplicados, por eso se busca por prefijo entre los Bones).
    const findBone = (prefix) => {
      let found = null;
      this.body.traverse((o) => {
        if (!found && o.isBone && o.name.startsWith(prefix)) found = o;
      });
      return found;
    };
    this.legL = findBone('Left_Leg');
    this.legR = findBone('Right_Leg');
    this.armL = findBone('Left_Arm');
    this.armR = findBone('Right_Arm');

    for (const n of [this.armL, this.armR, this.legL, this.legR]) {
      if (!n) continue;
      n.userData.baseQuat = n.quaternion.clone();
      n.userData.basePos = n.position.clone();
    }

    const label = this.position === 'GK' ? `${this.nickname} (GK)` : this.nickname;
    this.nameSprite = this.makeNameSprite(label, this.team);
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
    if (state === ANIM.KICK || state === ANIM.SLIDE) {
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
    this.body.rotation.z = 0;
    this.body.position.y = 0;

    // Lado real del vuelo del arquero (clavado / vuelo bajo), derivado del
    // movimiento real (no de un signo fijo) — así la animación siempre
    // coincide con el lado hacia el que se tira, tanto local como para
    // jugadores remotos (interpolados desde la red).
    if (!this._prevPos) this._prevPos = this.group.position.clone();
    if (dt > 1e-4) {
      const vx = (this.group.position.x - this._prevPos.x) / dt;
      const vz = (this.group.position.z - this._prevPos.z) / dt;
      const yaw = this.group.rotation.y;
      const lateral = vx * -Math.cos(yaw) + vz * Math.sin(yaw);
      if (Math.abs(lateral) > 0.3) this._diveSide = Math.sign(lateral);
    }
    this._prevPos.copy(this.group.position);

    // Poses con rotación de cuerpo entero (caídas, barrida, vuelos): el
    // pivote no coincide exactamente con el punto más bajo de la malla
    // posada, así que rotarlas puede hundir partes del cuerpo bajo el
    // piso — se corrigen al final con _clampToGround() (bounding box
    // real, con huesos posados, no la del bind-pose). Se restringe a
    // estas poses (no al ciclo de caminata/idle/salto/patada/atajada, que
    // ya no clipean) para no pagar el costo de ese cálculo cada frame.
    let groundSensitive = false;

    if (s === ANIM.KNOCKED) {
      // Cae hacia atrás por el empujón de la falta (el yaw ya lo orienta
      // en la dirección del golpe, ver GameClient).
      this.body.rotation.x = 1.05;
      poseLimb(this.legL, -0.5);
      poseLimb(this.legR, 0.5);
      poseLimb(this.armL, -1.1);
      poseLimb(this.armR, -1.1);
      groundSensitive = true;
    } else if (s === ANIM.SLIDE) {
      // Barrida: cuerpo reclinado, pierna derecha extendida al frente.
      this.body.rotation.x = -0.95;
      poseLimb(this.legR, -1.3);
      poseLimb(this.legL, 0.35);
      poseLimb(this.armL, 0.8);
      poseLimb(this.armR, 0.8);
      groundSensitive = true;
    } else if (s === ANIM.KICK) {
      // Patada rápida con la derecha (~0.3 s de swing).
      const t = Math.min(this.actionTimer / 0.3, 1);
      poseLimb(this.legR, -Math.sin(t * Math.PI) * 1.5);
      poseLimb(this.legL, 0.2);
      poseLimb(this.armL, -0.5);
      poseLimb(this.armR, 0.5);
    } else if (s === ANIM.STUNNED) {
      this.body.rotation.x = 0.25;
      poseLimb(this.armL, 0.6);
      poseLimb(this.armR, 0.6);
      poseLimb(this.legL, 0);
      poseLimb(this.legR, 0);
      groundSensitive = true;
    } else if (s === ANIM.DIVE) {
      // Clavado lateral del arquero: cuerpo completamente estirado y
      // recto, ambos brazos rectos hacia el cielo. El roll (rotation.z)
      // sigue el lado REAL hacia el que vuela (this._diveSide), no un
      // signo fijo — antes la animación siempre se veía hacia la
      // izquierda sin importar hacia qué lado se tirara el arquero.
      this.body.rotation.x = 0;
      this.body.rotation.z = -0.6 * this._diveSide;
      poseLimb(this.legL, 0);
      poseLimb(this.legR, 0);
      poseLimb(this.armL, -2.6);
      poseLimb(this.armR, -2.6);
      groundSensitive = true;
    } else if (s === ANIM.LOW_DIVE) {
      // Vuelo bajo del arquero: cae de costado y queda horizontal — es un
      // ROLL sobre Z (rotation.z), NO un picado hacia adelante
      // (rotation.x, que es lo que hacía antes y se veía como si se
      // tirara de cabeza al frente en vez de estirarse hacia el costado).
      this.body.rotation.x = 0.1;
      this.body.rotation.z = -1.3 * this._diveSide;
      poseLimb(this.legL, 0);
      poseLimb(this.legR, 0);
      poseLimb(this.armL, -2.6);
      poseLimb(this.armR, -2.6);
      groundSensitive = true;
    } else if (s === ANIM.DIVE_GROUND) {
      // Arquero recién aterrizado del clavado: tendido de costado hacia el
      // lado real por el que voló, antes de levantarse (en vez de saltar
      // de golpe del vuelo a la pose de pie).
      this.body.rotation.x = 0.1;
      this.body.rotation.z = -1.4 * this._diveSide;
      poseLimb(this.legL, 0);
      poseLimb(this.legR, 0);
      poseLimb(this.armL, -1.8);
      poseLimb(this.armR, -1.8);
      groundSensitive = true;
    } else if (s === ANIM.CATCH) {
      // Arquero con el balón atajado en las manos: cuerpo recto, brazos
      // extendidos al frente (pose "zombie").
      poseLimb(this.legL, 0);
      poseLimb(this.legR, 0);
      poseLimb(this.armL, -1.57);
      poseLimb(this.armR, -1.57);
    } else if (s === ANIM.JUMP) {
      poseLimb(this.legL, 0.5);
      poseLimb(this.legR, -0.5);
      poseLimb(this.armL, -2.6);
      poseLimb(this.armR, -2.6);
    } else {
      // Ciclo de caminata/carrera según velocidad real.
      const speedNorm = Math.min(horizontalSpeed / 7, 1.15);
      this.walkPhase += dt * (4 + horizontalSpeed * 1.7);
      const swing = Math.sin(this.walkPhase) * 0.85 * speedNorm;
      poseLimb(this.legL, swing);
      poseLimb(this.legR, -swing);
      poseLimb(this.armL, -swing * 0.8);
      poseLimb(this.armR, swing * 0.8);
    }

    if (groundSensitive) this._clampToGround();
  }

  /**
   * Empuja el cuerpo hacia arriba si, con la pose actual (rotación +
   * huesos posados), alguna parte quedó por debajo del piso (Y mundo < 0).
   * Usa el bounding box PRECISO (huesos posados, no el bind-pose — con
   * `setFromObject(obj)` sin el flag `precise` el box de un SkinnedMesh
   * ignora el posado de huesos y da resultados incorrectos para poses
   * como la barrida, donde una pierna se extiende bien hacia adelante).
   */
  _clampToGround() {
    this.group.updateMatrixWorld(true);
    _groundBox.setFromObject(this.body, true);
    if (_groundBox.min.y < 0) {
      this.body.position.y -= _groundBox.min.y;
    }
  }

  dispose() {
    if (this.nameSprite) {
      this.nameSprite.material.map.dispose();
      this.nameSprite.material.dispose();
    }
    this.group.removeFromParent();
  }
}
