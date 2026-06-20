import * as THREE from "https://esm.sh/three@0.164.0";
import { OrbitControls } from "https://esm.sh/three@0.164.0/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "https://esm.sh/three@0.164.0/examples/jsm/loaders/OBJLoader.js";

// import BufferGeometryUtils from "https://esm.sh/three@0.164.0/examples/jsm/utils/BufferGeometryUtils.js";
import {
  mergeVertices
} from "https://esm.sh/three@0.164.0/examples/jsm/utils/BufferGeometryUtils.js";

// import { LineGeometry } from 'https://esm.sh/three@0.164.0/addons/lines/LineGeometry.js';
// import { LineMaterial } from 'https://esm.sh/three@0.164.0/addons/lines/LineMaterial.js';
// import { Line2 } from 'https://esm.sh/three@0.164.0/addons/lines/Line2.js';

let highlightMesh = null;

let edgeLinesReference = null

let boundaryEdges = null;

const HIGHLIGHT_LAYER = 2;


let pointerDown = false;
let moved = false;
let downX = 0;
let downY = 0;

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

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
// renderer.sortObjects = true
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(activeCamera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(5, 5, 5);
scene.add(dir);

const defaultFaceMaterial = new THREE.MeshStandardMaterial({
    color: 0xcccccc,     // light gray default
    opacity: 1,
    transparent: true,
    roughness: 0.6,
    metalness: 0.0,
    side: THREE.DoubleSide,
    depthWrite: false,
    // flatShading: false,
    // alphaTest: 0.01,
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

        child.userData.surfaceClusters = buildSurfaceClusters(child.geometry, 179);

      // Smooth shading
      child.material = defaultFaceMaterial.clone();
    //   child.material = new THREE.MeshStandardMaterial({
    //     color: 0xcccccc,
    //     flatShading: false,
    //   });

    // child.material.vertexColors = true;
    // const vertexCount = child.geometry.attributes.position.count;
    // const colors = new Float32Array(vertexCount * 3);

    // // default: light gray
    // for (let i = 0; i < vertexCount; i++) {
    // colors[i*3+0] = 0.8;
    // colors[i*3+1] = 0.8;
    // colors[i*3+2] = 0.8;
    // }

    // child.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const vertexCount = child.geometry.attributes.position.count;
    const colors = new Float32Array(vertexCount * 4);

    // default: light gray, 25% opacity
    for (let i = 0; i < vertexCount; i++) {
    colors[i*4+0] = 0.8;   // R
    colors[i*4+1] = 0.8;   // G
    colors[i*4+2] = 0.8;   // B
    colors[i*4+3] = 0.25;  // A
    }

    child.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
    child.material.vertexColors = true;
    child.material.transparent = true;


    // child.userData.defaultColor = defaultFaceMaterial.color.clone();
    // child.userData.defaultOpacity = defaultFaceMaterial.opacity;

    const edgesGeo = new THREE.EdgesGeometry(child.geometry, 1);

    const posAttr = edgesGeo.getAttribute("position");
    const positionsArray = [];

    for (let i = 0; i < posAttr.count; i++) {
        positionsArray.push(
            posAttr.getX(i),
            posAttr.getY(i),
            posAttr.getZ(i)
        );
    }


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

function paintCluster(mesh, cluster, color, opacity) {
  const geo = mesh.geometry;
  const index = geo.index;
  const colors = geo.attributes.color;

  for (const f of cluster) {
    const i0 = index.getX(f*3 + 0);
    const i1 = index.getX(f*3 + 1);
    const i2 = index.getX(f*3 + 2);

//     [i0, i1, i2].forEach(i => {
//       colors.setXYZ(i, color.r, color.g, color.b);
//     });
//   }
    [i0, i1, i2].forEach(i => {
        colors.setX(i, color.r);
        colors.setY(i, color.g);
        colors.setZ(i, color.b);
        colors.setW(i, opacity);
        });
    }

  colors.needsUpdate = true;
}


function getBoundaryEdges(geometry, cluster) {
  const index = geometry.index;
  const faces = index.count / 3;

  // Build adjacency map: edgeKey → [faceA, faceB?]
  const edgeMap = new Map();

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

  const pos = geometry.attributes.position;
  const boundaryPositions = [];

  const clusterSet = new Set(cluster);

  // Boundary edges = edges with exactly ONE adjacent face in the cluster
  for (const [key, faceList] of edgeMap.entries()) {
    const inClusterCount = faceList.filter(f => clusterSet.has(f)).length;

    if (inClusterCount === 1) {
      // Parse key back into vertices
      const [v1, v2] = key.split("_").map(Number);

      const p1 = new THREE.Vector3().fromBufferAttribute(pos, v1);
      const p2 = new THREE.Vector3().fromBufferAttribute(pos, v2);

      boundaryPositions.push(p1.x, p1.y, p1.z);
      boundaryPositions.push(p2.x, p2.y, p2.z);
    }
  }

  return new THREE.Float32BufferAttribute(boundaryPositions, 3);
}


function createEdgeLines(geometry, threshold) {
  const edges = new THREE.EdgesGeometry(geometry, threshold);
  const positions = edges.attributes.position.array;
  
  // Convert positions array to flat array format for LineGeometry
  const positionsArray = [];
  for (let i = 0; i < positions.length; i++) {
    positionsArray.push(positions[i]);
  }
  
  // Create LineGeometry
  const geo = new LineGeometry();
  geo.setPositions(positionsArray);
  
  // Create LineMaterial with adjustable linewidth
  const mat = new LineMaterial({
    color: 0x000000,
    linewidth: 2, // ← ADJUST THIS VALUE (world units, not pixels)
    dashed: false
  });
  
  mat.resolution.set(window.innerWidth, window.innerHeight);
  
  // Create Line2 object
  const line = new Line2(geo, mat);
  line.computeLineDistances();
  
  return line;
}

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

    if (boundaryEdges) {
  scene.remove(boundaryEdges);
  boundaryEdges.geometry.dispose();
  boundaryEdges.material.dispose();
  boundaryEdges = null;
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

  activeCamera.layers.set(0);

  // Intersect with all meshes in the scene
  const intersects = raycaster.intersectObjects(scene.children, true);

activeCamera.layers.enableAll();

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

  paintCluster(hit.object, cluster, new THREE.Color(0xff0000), 0.5);


//   // Remove previous highlight
//   if (highlightMesh) {
//     scene.remove(highlightMesh);
//     highlightMesh.geometry.dispose();
//     highlightMesh.material.dispose();
//     highlightMesh = null;
//   }

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

//   const highlightGeo = new THREE.BufferGeometry();
//   highlightGeo.setFromPoints(verts);
//   highlightGeo.setIndex(inds);
//   highlightGeo.computeVertexNormals();

//   const highlightMat = new THREE.MeshBasicMaterial({
//     color: 0xff0000, //0x8B0000,
//     side: THREE.DoubleSide,
//     transparent: true,
//     opacity: 0.25
//   });

//   highlightMesh = new THREE.Mesh(highlightGeo, highlightMat);
//   highlightMesh.layers.set(HIGHLIGHT_LAYER);
//   scene.add(highlightMesh);
//   highlightMesh.raycast = () => {};

  if (boundaryEdges) {
  scene.remove(boundaryEdges);
  boundaryEdges.geometry.dispose();
  boundaryEdges.material.dispose();
  boundaryEdges = null;
}

// Build boundary edges
const boundaryAttr = getBoundaryEdges(geometry, cluster);

if (boundaryAttr.count > 0) {
  const boundaryGeo = new THREE.BufferGeometry();
  boundaryGeo.setAttribute("position", boundaryAttr);

  const boundaryMat = new THREE.LineBasicMaterial({
    color: 0xff0000,   // blue boundary edges (change as desired)
    linewidth: 2
  });

  boundaryEdges = new THREE.LineSegments(boundaryGeo, boundaryMat);

  // Transform into world space
  boundaryEdges.applyMatrix4(hit.object.matrixWorld);
  boundaryEdges.material.depthTest = false;
    boundaryEdges.material.depthWrite = false;
    boundaryEdges.renderOrder = 999;   // draw last, always on top

  boundaryEdges.layers.set(HIGHLIGHT_LAYER);
  scene.add(boundaryEdges);
  boundaryEdges.raycast = () => {};
}
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
