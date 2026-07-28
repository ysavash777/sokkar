import * as THREE from 'three';
import { BALL } from '/shared/constants.js';

/**
 * Balón: esfera blanca low-poly lisa, sin paneles ni costuras.
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
    this.mesh.add(sphere);
    this.mesh.position.y = BALL.RADIUS;

    this.prevPos = new THREE.Vector3();
  }

  /**
   * Rueda visualmente según el desplazamiento del frame — salvo que esté
   * atajada en las manos del arquero (`spin = false`), donde debe quedar
   * quieta en vez de seguir "rodando" solo por acompañar la posición del
   * jugador. `prevPos` se actualiza siempre para no generar un giro falso
   * de golpe cuando vuelve a soltarse.
   */
  updateRoll(dt, spin = true) {
    if (spin) {
      const dx = this.mesh.position.x - this.prevPos.x;
      const dz = this.mesh.position.z - this.prevPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-4) {
        const axis = new THREE.Vector3(dz, 0, -dx).normalize();
        this.mesh.rotateOnWorldAxis(axis, dist / BALL.RADIUS);
      }
    }
    this.prevPos.copy(this.mesh.position);
  }
}
