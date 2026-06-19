import * as THREE from "https://esm.sh/three@0.164.0";
import { OrbitControls } from "https://esm.sh/three@0.164.0/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "https://esm.sh/three@0.164.0/examples/jsm/loaders/OBJLoader.js";

// import BufferGeometryUtils from "https://esm.sh/three@0.164.0/examples/jsm/utils/BufferGeometryUtils.js";
import {
  mergeVertices
} from "https://esm.sh/three@0.164.0/examples/jsm/utils/BufferGeometryUtils.js";


const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();


const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeeeeee);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(3, 3, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(5, 5, 5);
scene.add(dir);

const loader = new OBJLoader();
// loader.load("model.obj", (obj) => {
//   obj.traverse((child) => {
//     if (child.isMesh) {
//       child.material = new THREE.MeshStandardMaterial({
//         color: 0xcccccc,
//         flatShading: true,
//       });
//     }
//   });
//   scene.add(obj);
// });
// loader.load("model.obj", (obj) => {
//   obj.traverse((child) => {
//     if (child.isMesh) {
//         child.geometry.deleteAttribute("normal");
//         child.geometry.computeVertexNormals();   // ← smooth shading fix
//         child.material = new THREE.MeshStandardMaterial({
//             color: 0xcccccc,
//             flatShading: false,                    // ← smooth shading ON
//         });
//     }
//   });
//   scene.add(obj);
// });
// loader.load("model.obj", (obj) => {
//   obj.traverse((child) => {
//     if (child.isMesh) {
//       child.geometry = BufferGeometryUtils.mergeVertices(child.geometry);
//       child.geometry.computeVertexNormals();

//       child.material = new THREE.MeshStandardMaterial({
//         color: 0xcccccc,
//         flatShading: false,
//       });
//     }
//   });
//   scene.add(obj);
// });

let surfaceClusters = null;

loader.load("model.obj", (obj) => {
  obj.traverse((child) => {
    if (child.isMesh) {

    // child.geometry = child.geometry.toNonIndexed(); // if needed

      // Remove bad normals
      child.geometry.deleteAttribute("normal");

      // Weld vertices (Fusion OBJ often needs this)
      child.geometry = mergeVertices(child.geometry);

      // Recompute smooth normals
      child.geometry.computeVertexNormals();

    //   surfaceClusters = buildSurfaceClusters(child.geometry, 25); // 12° threshold
        child.userData.surfaceClusters = buildSurfaceClusters(child.geometry, 170);
    //   console.log("Surface clusters:", surfaceClusters);

      // Smooth shading
      child.material = new THREE.MeshStandardMaterial({
        color: 0xcccccc,
        flatShading: false,
      });
    }
  });

  scene.add(obj);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener("pointerdown", onPointerDown);

function onPointerDown(event) {
  // Convert screen coords → normalized device coords
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Cast a ray from camera through the mouse position
  raycaster.setFromCamera(mouse, camera);

  // Intersect with all meshes in the scene
  const intersects = raycaster.intersectObjects(scene.children, true);

  if (intersects.length > 0) {
    const hit = intersects[0];

    console.log("Picked mesh:", hit.object);
    console.log("Face index:", hit.faceIndex);
    console.log("Face:", hit.face);

    highlightFace(hit);
  }
}

let lastHighlight = null;

// function highlightFace(hit) {
//   if (lastHighlight) {
//     lastHighlight.material.emissive.setHex(0x000000);
//   }

//   hit.object.material.emissive = new THREE.Color(0x3333ff);
//   lastHighlight = hit.object;
// }

let highlightMesh = null;

function highlightFace(hit) {
  const clusters = hit.object.userData.surfaceClusters;
  if (!clusters) return;

  const faceIndex = hit.faceIndex;
  const cluster = clusters.find(c => c.includes(faceIndex));
  if (!cluster) return;

  // Remove previous highlight
  if (highlightMesh) {
    scene.remove(highlightMesh);
    highlightMesh.geometry.dispose();
    highlightMesh.material.dispose();
    highlightMesh = null;
  }

  const geometry = hit.object.geometry;
  const index = geometry.index;
  const pos = geometry.attributes.position;

  const verts = [];
  const inds = [];
  let vCount = 0;

  for (const f of cluster) {
    const i0 = index.getX(f * 3 + 0);
    const i1 = index.getX(f * 3 + 1);
    const i2 = index.getX(f * 3 + 2);

    // ⬇️ Transform vertices into WORLD SPACE
    const v0 = new THREE.Vector3().fromBufferAttribute(pos, i0).applyMatrix4(hit.object.matrixWorld);
    const v1 = new THREE.Vector3().fromBufferAttribute(pos, i1).applyMatrix4(hit.object.matrixWorld);
    const v2 = new THREE.Vector3().fromBufferAttribute(pos, i2).applyMatrix4(hit.object.matrixWorld);

    verts.push(v0, v1, v2);
    inds.push(vCount, vCount + 1, vCount + 2);
    vCount += 3;
  }

  const highlightGeo = new THREE.BufferGeometry();
  highlightGeo.setFromPoints(verts);
  highlightGeo.setIndex(inds);
  highlightGeo.computeVertexNormals();

  const highlightMat = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.5
  });

  highlightMesh = new THREE.Mesh(highlightGeo, highlightMat);

  // ⬇️ No transforms needed — geometry is already in world space
  scene.add(highlightMesh);
}


// function highlightFace(hit) {
//   const clusters = hit.object.userData.surfaceClusters;
//   if (!clusters) return;

//   const faceIndex = hit.faceIndex;
//   const cluster = clusters.find(c => c.includes(faceIndex));
//   if (!cluster) return;
//   console.log("made it here");

//   // Remove previous highlight
//   if (highlightMesh) {
//     scene.remove(highlightMesh);
//     highlightMesh.geometry.dispose();
//     highlightMesh.material.dispose();
//     highlightMesh = null;
//   }

//   // Build geometry for all faces in the cluster
//   const geometry = hit.object.geometry;
//   const index = geometry.index;
//   const pos = geometry.attributes.position;

//   const verts = [];
//   const inds = [];

//   let vCount = 0;

//   for (const f of cluster) {
//     const a = index.getX(f * 3 + 0);
//     const b = index.getX(f * 3 + 1);
//     const c = index.getX(f * 3 + 2);

//     const vA = new THREE.Vector3().fromBufferAttribute(pos, a);
//     const vB = new THREE.Vector3().fromBufferAttribute(pos, b);
//     const vC = new THREE.Vector3().fromBufferAttribute(pos, c);

//     verts.push(vA, vB, vC);
//     inds.push(vCount, vCount + 1, vCount + 2);
//     vCount += 3;
//   }

//   const highlightGeo = new THREE.BufferGeometry().setFromPoints(verts);
//   highlightGeo.setIndex(inds);
//   highlightGeo.computeVertexNormals();

//   const highlightMat = new THREE.MeshBasicMaterial({
//     color: 0xff0000,
//     side: THREE.DoubleSide,
//     transparent: true,
//     opacity: 0.5
//   });

//   highlightMesh = new THREE.Mesh(highlightGeo, highlightMat);

//   hit.object.localToWorld(highlightMesh.position);
//   highlightMesh.quaternion.copy(hit.object.getWorldQuaternion(new THREE.Quaternion()));
//   highlightMesh.scale.copy(hit.object.getWorldScale(new THREE.Vector3()));

//   scene.add(highlightMesh);
// }


// function highlightFace(hit) {
//   // Remove previous highlight
//   if (highlightMesh) {
//     scene.remove(highlightMesh);
//     highlightMesh.geometry.dispose();
//     highlightMesh.material.dispose();
//     highlightMesh = null;
//   }

//   const geometry = hit.object.geometry;
//   const index = geometry.index;
//   const pos = geometry.attributes.position;

//   // Get the 3 vertex indices of the picked face
//   const a = index.getX(hit.faceIndex * 3 + 0);
//   const b = index.getX(hit.faceIndex * 3 + 1);
//   const c = index.getX(hit.faceIndex * 3 + 2);

//   // Extract vertex positions
//   const vA = new THREE.Vector3().fromBufferAttribute(pos, a);
//   const vB = new THREE.Vector3().fromBufferAttribute(pos, b);
//   const vC = new THREE.Vector3().fromBufferAttribute(pos, c);

//   // Build a new geometry for the highlight triangle
//   const highlightGeo = new THREE.BufferGeometry().setFromPoints([vA, vB, vC]);
//   highlightGeo.setIndex([0, 1, 2]);
//   highlightGeo.computeVertexNormals();

//   // Highlight material
//   const highlightMat = new THREE.MeshBasicMaterial({
//     color: 0xff0000,
//     side: THREE.DoubleSide,
//     transparent: true,
//     opacity: 0.6
//   });

//   // Create the highlight mesh
//   highlightMesh = new THREE.Mesh(highlightGeo, highlightMat);

//   // Position it in the same coordinate space as the original mesh
//   hit.object.localToWorld(highlightMesh.position);
//   highlightMesh.quaternion.copy(hit.object.getWorldQuaternion(new THREE.Quaternion()));
//   highlightMesh.scale.copy(hit.object.getWorldScale(new THREE.Vector3()));

//   scene.add(highlightMesh);
// }

function buildAdjacency(geometry) {
  const index = geometry.index;
  const faces = index.count / 3;

  const edgeMap = new Map(); // "v1_v2" → [faceIndex]

  function addEdge(a, b, face) {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (!edgeMap.has(key)) edgeMap.set(key, []);
    edgeMap.get(key).push(face);
  }

  for (let f = 0; f < faces; f++) {
    const a = index.getX(f * 3 + 0);
    const b = index.getX(f * 3 + 1);
    const c = index.getX(f * 3 + 2);

    addEdge(a, b, f);
    addEdge(b, c, f);
    addEdge(c, a, f);
  }

  // Build adjacency list: face → neighboring faces
  const adjacency = Array.from({ length: faces }, () => []);

  for (const [key, faceList] of edgeMap.entries()) {
    if (faceList.length === 2) {
      const [f1, f2] = faceList;
      adjacency[f1].push(f2);
      adjacency[f2].push(f1);
    }
  }

  return adjacency;
}

function buildSurfaceClusters(geometry, angleThresholdDeg = 10) {
  const adjacency = buildAdjacency(geometry);
  const normals = geometry.attributes.normal;
  const faces = adjacency.length;

  const visited = new Array(faces).fill(false);
  const clusters = [];

  const angleThreshold = Math.cos(THREE.MathUtils.degToRad(angleThresholdDeg));

//   function faceNormal(f) {
//     const nx = normals.getX(f * 3);
//     const ny = normals.getY(f * 3);
//     const nz = normals.getZ(f * 3);
//     return new THREE.Vector3(nx, ny, nz).normalize();
//   }
function faceNormal(f, geometry) {
  const index = geometry.index;
  const pos = geometry.attributes.position;

  const i0 = index.getX(f * 3 + 0);
  const i1 = index.getX(f * 3 + 1);
  const i2 = index.getX(f * 3 + 2);

  const v0 = new THREE.Vector3().fromBufferAttribute(pos, i0);
  const v1 = new THREE.Vector3().fromBufferAttribute(pos, i1);
  const v2 = new THREE.Vector3().fromBufferAttribute(pos, i2);

  const n = new THREE.Vector3()
    .subVectors(v1, v0)
    .cross(new THREE.Vector3().subVectors(v2, v0))
    .normalize();

  return n;
}


  for (let f = 0; f < faces; f++) {
    if (visited[f]) continue;

    const cluster = [];
    const stack = [f];
    const n0 = faceNormal(f, geometry);

    visited[f] = true;

    while (stack.length > 0) {
      const cur = stack.pop();
      cluster.push(cur);

      for (const nb of adjacency[cur]) {
        if (visited[nb]) continue;

        const n1 = faceNormal(nb, geometry);
        const dot = n0.dot(n1);

        if (dot >= angleThreshold) {
          visited[nb] = true;
          stack.push(nb);
        }
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}



// // import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.164.0/build/three.module.js";
// // import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.164.0/examples/jsm/controls/OrbitControls.js";
// // import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.164.0/examples/jsm/loaders/GLTFLoader.js";

// import * as THREE from "https://esm.sh/three@0.164.0";
// import { OrbitControls } from "https://esm.sh/three@0.164.0/examples/jsm/controls/OrbitControls.js";
// import { GLTFLoader } from "https://esm.sh/three@0.164.0/examples/jsm/loaders/GLTFLoader.js";


// const scene = new THREE.Scene();
// scene.background = new THREE.Color(0xeeeeee);

// const camera = new THREE.PerspectiveCamera(
//   45,
//   window.innerWidth / window.innerHeight,
//   0.1,
//   1000
// );
// camera.position.set(3, 3, 3);

// const renderer = new THREE.WebGLRenderer({ antialias: true });
// renderer.setSize(window.innerWidth, window.innerHeight);
// document.body.appendChild(renderer.domElement);

// const controls = new OrbitControls(camera, renderer.domElement);
// controls.enableDamping = true;

// scene.add(new THREE.AmbientLight(0xffffff, 0.8));
// const dir = new THREE.DirectionalLight(0xffffff, 0.8);
// dir.position.set(5, 5, 5);
// scene.add(dir);

// const loader = new GLTFLoader();
// loader.load("model.glb", (gltf) => {
//   scene.add(gltf.scene);
// });

// function animate() {
//   requestAnimationFrame(animate);
//   controls.update();
//   renderer.render(scene, camera);
// }
// animate();

// window.addEventListener("resize", () => {
//   camera.aspect = window.innerWidth / window.innerHeight;
//   camera.updateProjectionMatrix();
//   renderer.setSize(window.innerWidth, window.innerHeight);
// });
