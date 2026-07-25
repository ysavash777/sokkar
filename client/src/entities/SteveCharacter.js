import * as THREE from 'three';
import { ANIM, TEAM_COLORS } from '/shared/constants.js';

/**
 * "Steve" de Minecraft sin texturas, solo colores.
 * Construido por extremidades independientes (cabeza, torso, 2 brazos,
 * 2 piernas) con pivotes en las articulaciones — el personaje NO es un
 * bloque único: cada extremidad tiene su propia geometría/colisión
 * (el servidor replica estas cápsulas en shared/server physics).
 */
const SKIN = 0xc9985f;
const PANTS = 0x3b3b6e;

// Geometrías compartidas entre todas las instancias (optimización).
let geoCache = null;
function getGeos() {
  if (geoCache) return geoCache;
  geoCache = {
    head: new THREE.BoxGeometry(0.45, 0.45, 0.45),
    torso: new THREE.BoxGeometry(0.45, 0.68, 0.24),
    limb: new THREE.BoxGeometry(0.2, 0.68, 0.2),
  };
  return geoCache;
}

export class SteveCharacter {
  constructor(team, nickname) {
    this.group = new THREE.Group();
    this.team = team;
    this.walkPhase = 0;
    this.animState = ANIM.IDLE;
    this.actionTimer = 0; // temporizador de kick/extend/slide

    const g = getGeos();
    const matSkin = new THREE.MeshLambertMaterial({ color: SKIN });
    const matShirt = new THREE.MeshLambertMaterial({ color: TEAM_COLORS[team] });
    const matPants = new THREE.MeshLambertMaterial({ color: PANTS });

    // Torso (centro en y=1.19, va de 0.85 a 1.53).
    this.torso = new THREE.Mesh(g.torso, matShirt);
    this.torso.position.y = 1.19;

    // Cabeza.
    this.head = new THREE.Mesh(g.head, matSkin);
    this.head.position.y = 1.76;

    // Extremidades con pivote en la articulación (hombro/cadera):
    // el mesh cuelga hacia abajo dentro de un Group pivote.
    this.armL = this.makeLimb(g.limb, matShirt, -0.33, 1.5);
    this.armR = this.makeLimb(g.limb, matShirt, 0.33, 1.5);
    this.legL = this.makeLimb(g.limb, matPants, -0.12, 0.85);
    this.legR = this.makeLimb(g.limb, matPants, 0.12, 0.85);

    // Contenedor del cuerpo para poder inclinarlo entero (barrida).
    this.body = new THREE.Group();
    this.body.add(this.torso, this.head, this.armL, this.armR, this.legL, this.legR);
    this.group.add(this.body);

    this.nameSprite = this.makeNameSprite(nickname, team);
    this.group.add(this.nameSprite);
  }

  makeLimb(geo, mat, x, pivotY) {
    const pivot = new THREE.Group();
    pivot.position.set(x, pivotY, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = -0.34; // cuelga del pivote
    pivot.add(mesh);
    return pivot;
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
    sprite.position.y = 2.35;
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
    this.actionTimer += dt;
    const s = this.animState;

    // Reset de pose base.
    this.body.rotation.x = 0;
    this.body.position.y = 0;
    this.legR.position.z = 0;

    if (s === ANIM.SLIDE) {
      // Barrida: cuerpo reclinado, pierna derecha extendida al frente.
      this.body.rotation.x = -1.15;
      this.body.position.y = -0.55;
      this.legR.rotation.x = -1.3;
      this.legL.rotation.x = 0.35;
      this.armL.rotation.x = 0.8;
      this.armR.rotation.x = 0.8;
      return;
    }

    if (s === ANIM.KICK) {
      // Patada rápida con la derecha (~0.3 s de swing).
      const t = Math.min(this.actionTimer / 0.3, 1);
      this.legR.rotation.x = -Math.sin(t * Math.PI) * 1.5;
      this.legL.rotation.x = 0.2;
      this.armL.rotation.x = -0.5;
      this.armR.rotation.x = 0.5;
      return;
    }

    if (s === ANIM.EXTEND) {
      // Cruzar pie: extensión defensiva corta del pie derecho.
      this.legR.rotation.x = -0.9;
      this.legR.position.z = 0.12;
      this.legL.rotation.x = 0.15;
      this.armL.rotation.x = 0.3;
      this.armR.rotation.x = -0.3;
      return;
    }

    if (s === ANIM.STUNNED) {
      this.body.rotation.x = 0.25;
      this.armL.rotation.x = 0.6;
      this.armR.rotation.x = 0.6;
      this.legL.rotation.x = 0;
      this.legR.rotation.x = 0;
      return;
    }

    if (s === ANIM.JUMP) {
      this.legL.rotation.x = 0.5;
      this.legR.rotation.x = -0.5;
      this.armL.rotation.x = -2.6;
      this.armR.rotation.x = -2.6;
      return;
    }

    // Ciclo de caminata/carrera según velocidad real.
    const speedNorm = Math.min(horizontalSpeed / 7, 1.15);
    this.walkPhase += dt * (4 + horizontalSpeed * 1.7);
    const swing = Math.sin(this.walkPhase) * 0.85 * speedNorm;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.armL.rotation.x = -swing * 0.8;
    this.armR.rotation.x = swing * 0.8;
  }

  dispose() {
    this.nameSprite.material.map.dispose();
    this.nameSprite.material.dispose();
    this.group.removeFromParent();
  }
}
