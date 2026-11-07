import * as THREE from 'three';
import { buildConsoleReceiverData } from './console-receiver-data.js';
export function buildConsoleReceiver(...args) {
  const data = buildConsoleReceiverData(...args),
    geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  geometry.setAttribute('shadowStrength', new THREE.Float32BufferAttribute(data.strengths, 1));
  geometry.setAttribute('plateUv', new THREE.Float32BufferAttribute(data.plateUvs, 2));
  geometry.setIndex(data.indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.userData.instrumentRect = data.instrumentRect;
  geometry.userData.instrumentVertexStart = data.instrumentVertexStart;
  return geometry;
}
