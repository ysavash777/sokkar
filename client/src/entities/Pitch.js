import * as THREE from 'three';
import { FIELD } from '/shared/constants.js';

/**
 * Cancha 4v4: césped, líneas, arcos y paredes bajas.
 * Sin texturas — solo materiales de color plano (Lambert/Basic)
 * para mantener el coste de render mínimo.
 */
export function createPitch() {
  const pitch = new THREE.Group();
  const halfL = FIELD.LENGTH / 2;
  const halfW = FIELD.WIDTH / 2;

  // Césped.
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(FIELD.LENGTH + 8, FIELD.WIDTH + 8),
    new THREE.MeshLambertMaterial({ color: 0x2e8b3d }),
  );
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = true;
  pitch.add(grass);

  // Franjas alternadas (misma altura, sin textura).
  const stripeMat = new THREE.MeshLambertMaterial({ color: 0x33984a });
  for (let i = 0; i < 6; i++) {
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(FIELD.LENGTH / 6, FIELD.WIDTH), stripeMat);
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(-halfL + FIELD.LENGTH / 12 + i * (FIELD.LENGTH / 3), 0.005, 0);
    if (i < 3) pitch.add(stripe);
  }

  // Líneas de cancha.
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const line = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.01, z);
    pitch.add(m);
  };
  line(FIELD.LENGTH, 0.15, 0, -halfW); // banda inferior
  line(FIELD.LENGTH, 0.15, 0, halfW); // banda superior
  line(0.15, FIELD.WIDTH, -halfL, 0); // línea de gol izq
  line(0.15, FIELD.WIDTH, halfL, 0); // línea de gol der
  line(0.15, FIELD.WIDTH, 0, 0); // media cancha

  // Círculo central.
  const circle = new THREE.Mesh(new THREE.RingGeometry(5.85, 6, 48), lineMat);
  circle.rotation.x = -Math.PI / 2;
  circle.position.y = 0.01;
  pitch.add(circle);

  // Arcos.
  pitch.add(createGoal(-halfL, 1));
  pitch.add(createGoal(halfL, -1));

  // Paredes invisibles-visuales bajas alrededor (el rebote lo maneja el server).
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x1e293b, transparent: true, opacity: 0.35 });
  const mkWall = (w, d, x, z) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 1, d), wallMat);
    wall.position.set(x, 0.5, z);
    pitch.add(wall);
  };
  mkWall(FIELD.LENGTH + 8, 0.3, 0, -halfW - 0.15);
  mkWall(FIELD.LENGTH + 8, 0.3, 0, halfW + 0.15);
  const sideLen = halfW - FIELD.GOAL_WIDTH / 2;
  mkWall(0.3, sideLen, -halfL - 0.15, -(FIELD.GOAL_WIDTH / 2 + sideLen / 2));
  mkWall(0.3, sideLen, -halfL - 0.15, FIELD.GOAL_WIDTH / 2 + sideLen / 2);
  mkWall(0.3, sideLen, halfL + 0.15, -(FIELD.GOAL_WIDTH / 2 + sideLen / 2));
  mkWall(0.3, sideLen, halfL + 0.15, FIELD.GOAL_WIDTH / 2 + sideLen / 2);

  return pitch;
}

function createGoal(x, facing) {
  const goal = new THREE.Group();
  const postMat = new THREE.MeshLambertMaterial({ color: 0xf5f5f5 });
  const netMat = new THREE.MeshLambertMaterial({
    color: 0xdddddd,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
  });
  const gw = FIELD.GOAL_WIDTH;
  const gh = FIELD.GOAL_HEIGHT;
  const gd = FIELD.GOAL_DEPTH;
  const r = 0.09;

  const postGeo = new THREE.CylinderGeometry(r, r, gh, 8);
  const postL = new THREE.Mesh(postGeo, postMat);
  postL.position.set(0, gh / 2, -gw / 2);
  const postR = new THREE.Mesh(postGeo, postMat);
  postR.position.set(0, gh / 2, gw / 2);

  const bar = new THREE.Mesh(new THREE.CylinderGeometry(r, r, gw, 8), postMat);
  bar.rotation.x = Math.PI / 2;
  bar.position.y = gh;

  // "Red" plana de color translúcido (fondo + laterales + techo).
  const back = new THREE.Mesh(new THREE.PlaneGeometry(gw, gh), netMat);
  back.rotation.y = Math.PI / 2;
  back.position.set(-facing * gd, gh / 2, 0);

  const sideGeo = new THREE.PlaneGeometry(gd, gh);
  const sideL = new THREE.Mesh(sideGeo, netMat);
  sideL.position.set(-facing * gd / 2, gh / 2, -gw / 2);
  const sideR = new THREE.Mesh(sideGeo, netMat);
  sideR.position.set(-facing * gd / 2, gh / 2, gw / 2);

  const roof = new THREE.Mesh(new THREE.PlaneGeometry(gd, gw), netMat);
  roof.rotation.x = Math.PI / 2;
  roof.rotation.z = Math.PI / 2;
  roof.position.set(-facing * gd / 2, gh, 0);

  goal.add(postL, postR, bar, back, sideL, sideR, roof);
  goal.position.x = x;
  return goal;
}
