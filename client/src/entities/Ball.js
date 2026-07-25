import * as THREE from 'three';
import { BALL } from '/shared/constants.js';

/**
 * Balón: esfera blanca low-poly con paneles de color (sin texturas).
 * La posición real la dicta el servidor; el cliente interpola y,
 * cuando el jugador local tiene la posesión, la predice localmente.
 */
export class Ball {
  constructor() {
    this.mesh = new THREE.Group();
    const sphere = new THREE.Mesh(
      new THREE.IcosahedronGeometry(BALL.RADIUS, 1),
      new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    );
    // "Paneles" oscuros: segunda esfera wireframe barata para lectura del giro.
    const seams = new THREE.Mesh(
      new THREE.IcosahedronGeometry(BALL.RADIUS * 1.002, 1),
      new THREE.MeshBasicMaterial({ color: 0x222222, wireframe: true }),
    );
    this.mesh.add(sphere, seams);
    this.mesh.position.y = BALL.RADIUS;

    this.prevPos = new THREE.Vector3();
  }

  /** Rueda visualmente según el desplazamiento del frame. */
  updateRoll(dt) {
    const dx = this.mesh.position.x - this.prevPos.x;
    const dz = this.mesh.position.z - this.prevPos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1e-4) {
      const axis = new THREE.Vector3(dz, 0, -dx).normalize();
      this.mesh.rotateOnWorldAxis(axis, dist / BALL.RADIUS);
    }
    this.prevPos.copy(this.mesh.position);
  }
}
