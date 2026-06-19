import * as THREE from "https://esm.sh/three@0.164.0";
import { OrbitControls } from "https://esm.sh/three@0.164.0/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "https://esm.sh/three@0.164.0/examples/jsm/loaders/OBJLoader.js";

// import BufferGeometryUtils from "https://esm.sh/three@0.164.0/examples/jsm/utils/BufferGeometryUtils.js";
import {
  mergeVertices
} from "https://esm.sh/three@0.164.0/examples/jsm/utils/BufferGeometryUtils.js";

let highlightMesh = null;

let pointerDown = false;
let moved = false;
let downX = 0;
let downY = 0;

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

const aspect = window.innerWidth / window.innerHeight;
const orthoSize = 4; // adjust to taste

const orthoCamera = new THREE.OrthographicCamera(
    -orthoSize * aspect,
    orthoSize * aspect,
    orthoSize,
    -orthoSize,
    0.1,
    1000
);
orthoCamera.position.copy(camera.position);
orthoCamera.lookAt(0, 0, 0);

let activeCamera = orthoCamera

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(activeCamera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(5, 5, 5);
scene.add(dir);

const defaultFaceMaterial = new THREE.MeshStandardMaterial({
    color: 0xcccccc,     // light gray default
    opacity: 0.5,
    transparent: true,
    roughness: 0.6,
    metalness: 0.0,
    // flatShading: false,
});

const loader = new OBJLoader();

loader.load("model.obj", (obj) => {
  obj.traverse((child) => {
    if (child.isMesh) {

    // child.geometry = child.geometry.toNonIndexed(); // if needed

      // Remove bad normals
      child.geometry.deleteAttribute("normal");

      // Weld vertices (Fusion OBJ often needs this)
      child.geometry = mergeVertices(child.geometry);

    //   child.geometry = weldByPosition(child.geometry);

      // Recompute smooth normals
      child.geometry.computeVertexNormals();

    //   surfaceClusters = buildSurfaceClusters(child.geometry, 25); // 12° threshold
        child.userData.surfaceClusters = buildSurfaceClusters(child.geometry, 179);
    //   console.log("Surface clusters:", surfaceClusters);

      // Smooth shading
      child.material = defaultFaceMaterial.clone();
    //   child.material = new THREE.MeshStandardMaterial({
    //     color: 0xcccccc,
    //     flatShading: false,
    //   });

    // child.userData.defaultColor = defaultFaceMaterial.color.clone();
    // child.userData.defaultOpacity = defaultFaceMaterial.opacity;

    const edges = new THREE.EdgesGeometry(child.geometry, 20); // 1° threshold
    const edgeLines = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({
            color: 0x000000,
            linewidth: 1
        })
    );
    edgeLines.raycast = () => {};
    edgeLines.material.depthTest = false;
    edgeLines.material.depthWrite = false;
    edgeLines.renderOrder = 2;
    child.add(edgeLines);

    }
  });

  scene.add(obj);
});

// FUNCTIONS

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, activeCamera);
}
animate();

function deselectAllFaces() {
    if (highlightMesh) {
        scene.remove(highlightMesh);
        highlightMesh.geometry.dispose();
        highlightMesh.material.dispose();
        highlightMesh = null;
    }

    // selectedFaceCluster = null;  // if you track this
    // clear UI, etc.
}

function onPointerDown(event) {
  // Convert screen coords → normalized device coords
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Cast a ray from camera through the mouse position
  raycaster.setFromCamera(mouse, activeCamera);

  // Intersect with all meshes in the scene
  const intersects = raycaster.intersectObjects(scene.children, true);

  if (intersects.length > 0) {
    const hit = intersects[0];

    console.log("Picked mesh:", hit.object);
    console.log("Face index:", hit.faceIndex);
    console.log("Face:", hit.face);

    highlightFace(hit);
  } else {
    deselectAllFaces();
}
}

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

function weldByPosition(geometry, tolerance = 1e-5) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const vertCount = pos.count;

  const newVerts = [];
  const newIndex = new Array(index.count);

  const map = new Map();

  const key = (x, y, z) =>
    `${Math.round(x / tolerance)}_${Math.round(y / tolerance)}_${Math.round(z / tolerance)}`;

  for (let i = 0; i < vertCount; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    const k = key(x, y, z);

    if (!map.has(k)) {
      map.set(k, newVerts.length);
      newVerts.push(x, y, z);
    }
  }

  // Build new index buffer
  for (let i = 0; i < index.count; i++) {
    const vi = index.getX(i);
    const x = pos.getX(vi);
    const y = pos.getY(vi);
    const z = pos.getZ(vi);
    const k = key(x, y, z);
    newIndex[i] = map.get(k);
  }

  const newGeo = new THREE.BufferGeometry();
  newGeo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(newVerts, 3)
  );
  newGeo.setIndex(newIndex);

  return newGeo;
}

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

function toggleCameraMode() {
    if (activeCamera === camera) {
        // Switch to ortho
        orthoCamera.position.copy(camera.position);
        orthoCamera.quaternion.copy(camera.quaternion);
        activeCamera = orthoCamera;
    } else {
        // Switch to perspective
        camera.position.copy(orthoCamera.position);
        camera.quaternion.copy(orthoCamera.quaternion);
        activeCamera = camera;
    }

    controls.object = activeCamera;
    controls.update();
}

// HANDLERS

window.addEventListener("resize", () => {
  activeCamera.aspect = window.innerWidth / window.innerHeight;
  activeCamera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// window.addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointerdown", (e) => {
    pointerDown = true;
    moved = false;
    downX = e.clientX;
    downY = e.clientY;
});
window.addEventListener("pointermove", (e) => {
    if (!pointerDown) return;

    const dx = e.clientX - downX;
    const dy = e.clientY - downY;

    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        moved = true;
    }
});
window.addEventListener("pointerup", (e) => {
    pointerDown = false;

    if (moved) {
        // It was a drag → do NOT change selection
        return;
    }

    onPointerDown(e)
});

window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        deselectAllFaces();
    }
});

window.addEventListener("resize", () => {
    const aspect = window.innerWidth / window.innerHeight;

    camera.aspect = aspect;
    camera.updateProjectionMatrix();

    orthoCamera.left = -orthoSize * aspect;
    orthoCamera.right = orthoSize * aspect;
    orthoCamera.top = orthoSize;
    orthoCamera.bottom = -orthoSize;
    orthoCamera.updateProjectionMatrix();

    renderer.setSize(window.innerWidth, window.innerHeight);
});
