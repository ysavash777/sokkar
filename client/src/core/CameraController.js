import * as THREE from 'three';
import { CAMERA } from '/shared/constants.js';

/**
 * Cámara orbital 360° en tercera persona.
 * IMPORTANTE: la cámara NO rota al personaje; solo define la dirección
 * de referencia del movimiento (WASD relativo a cámara) y permite mirar
 * hacia los lados libremente.
 */
export class CameraController {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = 0.35;
    this.distance = 6.5;
    this.heightOffset = 1.5;
    this.sensitivity = 0.0024;
    this.target = new THREE.Vector3();
    this.smoothTarget = new THREE.Vector3();
  }

  applyMouseDelta(dx, dy) {
    this.yaw -= dx * this.sensitivity;
    this.pitch = Math.max(CAMERA.PITCH_MIN, Math.min(CAMERA.PITCH_MAX, this.pitch + dy * this.sensitivity));
  }

  update(targetPos, dt) {
    this.target.set(targetPos.x, targetPos.y + this.heightOffset, targetPos.z);
    const k = 1 - Math.exp(-12 * dt);
    this.smoothTarget.lerp(this.target, k);

    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.smoothTarget.x - Math.sin(this.yaw) * cp * this.distance,
      this.smoothTarget.y + Math.sin(this.pitch) * this.distance,
      this.smoothTarget.z - Math.cos(this.yaw) * cp * this.distance,
    );
    // No dejar la cámara bajo el piso.
    if (this.camera.position.y < 0.4) this.camera.position.y = 0.4;
    this.camera.lookAt(this.smoothTarget);
  }
}
