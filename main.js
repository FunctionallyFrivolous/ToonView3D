// ------------------------------------------------------------
// Imports
// ------------------------------------------------------------

import * as THREE from "https://esm.sh/three@0.164.0";
import { OrbitControls } from "https://esm.sh/three@0.164.0/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "https://esm.sh/three@0.164.0/examples/jsm/loaders/OBJLoader.js";
import { mergeVertices } from "https://esm.sh/three@0.164.0/examples/jsm/utils/BufferGeometryUtils.js";

import { LineMaterial } from "https://esm.sh/three@0.164.0/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "https://esm.sh/three@0.164.0/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "https://esm.sh/three@0.164.0/examples/jsm/lines/LineSegmentsGeometry.js";


// ------------------------------------------------------------
// Scene setup
// ------------------------------------------------------------

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
const orthoSize = 4;

const orthoCamera = new THREE.OrthographicCamera(
    -orthoSize * aspect, orthoSize * aspect,
    orthoSize, -orthoSize,
    0.1, 1000
);
orthoCamera.position.copy(camera.position);
orthoCamera.lookAt(0, 0, 0);

let activeCamera = orthoCamera;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(activeCamera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 2));
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(5, 5, 5);
scene.add(dir);


// ------------------------------------------------------------
// Materials
// ------------------------------------------------------------

const defaultFaceMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    opacity: 1,
    transparent: true,
    roughness: 0.6,
    metalness: 0.0,
    side: THREE.DoubleSide,
    depthWrite: false
});


// ------------------------------------------------------------
// State
// ------------------------------------------------------------

let boundaryEdges = null;
let currentSelectedMesh = null;
let currentSelectedCluster = null;

let pointerDown = false;
let moved = false;
let downX = 0;
let downY = 0;

let pickMode = false;

const undoStack = [];
const redoStack = [];

const edgeStyles = new WeakMap();          // mesh → Map(clusterIndex → style)
const persistentEdgeLines = new WeakMap(); // mesh → Map(clusterIndex → LineSegments2)

const HIGHLIGHT_LAYER = 2;


// ------------------------------------------------------------
// UI elements
// ------------------------------------------------------------

const colorInput = document.getElementById("faceColor");
const opacityInput = document.getElementById("faceOpacity");

const edgeColorInput = document.getElementById("edgeColor");
const edgeWidthInput = document.getElementById("edgeWidth");
const edgeDashScaleInput = document.getElementById("edgeDashScale");
const edgeDashedInput = document.getElementById("edgeDashed");

const colorPanel = document.getElementById("colorPanel");


// ------------------------------------------------------------
// OBJ loading
// ------------------------------------------------------------

const loader = new OBJLoader();

loader.load("model.obj", (obj) => {
    obj.traverse((child) => {
        if (child.isMesh) {
            child.geometry.deleteAttribute("normal");
            child.geometry = mergeVertices(child.geometry);
            child.geometry.computeVertexNormals();

            child.userData.surfaceClusters = buildSurfaceClusters(
                child.geometry,
                179
            );

            child.material = defaultFaceMaterial.clone();

            const vertexCount = child.geometry.attributes.position.count;
            const colors = new Float32Array(vertexCount * 4);

            for (let i = 0; i < vertexCount; i++) {
                colors[i * 4 + 0] = 0;
                colors[i * 4 + 1] = 0;
                colors[i * 4 + 2] = 0;
                colors[i * 4 + 3] = 0.1;
            }

            child.geometry.setAttribute(
                "color",
                new THREE.BufferAttribute(colors, 4)
            );
            child.material.vertexColors = true;
            child.material.transparent = true;

            edgeStyles.set(child, new Map());
            persistentEdgeLines.set(child, new Map());
        }
    });

    scene.add(obj);
});


// ------------------------------------------------------------
// Boundary-only edge extraction (correct logic)
// ------------------------------------------------------------

function getBoundaryEdges(geometry, cluster) {
    const index = geometry.index;
    const faces = index.count / 3;

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

    for (const [key, faceList] of edgeMap.entries()) {
        const inClusterCount = faceList.filter((f) => clusterSet.has(f)).length;

        if (inClusterCount === 1) {
            const [v1, v2] = key.split("_").map(Number);

            const p1 = new THREE.Vector3().fromBufferAttribute(pos, v1);
            const p2 = new THREE.Vector3().fromBufferAttribute(pos, v2);

            boundaryPositions.push(p1.x, p1.y, p1.z);
            boundaryPositions.push(p2.x, p2.y, p2.z);
        }
    }

    return new THREE.Float32BufferAttribute(boundaryPositions, 3);
}

// ------------------------------------------------------------
// Persistent fat-line edges (boundary-only, diagonal-free)
// ------------------------------------------------------------

function updatePersistentEdgeLinesForCluster(mesh, cluster, style) {
    const clusters = mesh.userData.surfaceClusters;
    const clusterIndex = clusters.indexOf(cluster);
    if (clusterIndex === -1) return;

    const meshLines = persistentEdgeLines.get(mesh);

    // Remove old line
    const existing = meshLines.get(clusterIndex);
    if (existing) {
        scene.remove(existing);
        existing.geometry.dispose();
        existing.material.dispose();
    }

    // Boundary edges only (correct logic)
    const edgeAttr = getBoundaryEdges(mesh.geometry, cluster);
    if (edgeAttr.count === 0) {
        meshLines.delete(clusterIndex);
        return;
    }

    // ⭐ Use LineSegmentsGeometry (NOT LineGeometry)
    const geo = new LineSegmentsGeometry();
    geo.setPositions(edgeAttr.array); // preserves segment boundaries

    const mat = new LineMaterial({
        color: style.color.getHex(),
        linewidth: style.width,
        dashed: style.dashed,
        dashSize: 1 * style.dashScale,
        gapSize: 1 * style.dashScale
    });

    mat.resolution.set(window.innerWidth, window.innerHeight);
    mat.depthTest = true;
    // mat.depthWrite = false;

    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;

    // ⭐ Use LineSegments2 (NOT Line2)
    const line = new LineSegments2(geo, mat);
    line.computeLineDistances();
    line.applyMatrix4(mesh.matrixWorld);
    line.renderOrder = 5;
    line.raycast = () => {};

    scene.add(line);
    meshLines.set(clusterIndex, line);
}


// ------------------------------------------------------------
// Face painting
// ------------------------------------------------------------

function paintCluster(mesh, cluster, color, opacity, recordHistory = true) {
    const geo = mesh.geometry;
    const index = geo.index;
    const colors = geo.attributes.color;

    const previousColors = [];

    for (const f of cluster) {
        const i0 = index.getX(f * 3 + 0);
        const i1 = index.getX(f * 3 + 1);
        const i2 = index.getX(f * 3 + 2);

        [i0, i1, i2].forEach((i) => {
            previousColors.push({
                index: i,
                r: colors.getX(i),
                g: colors.getY(i),
                b: colors.getZ(i),
                a: colors.getW(i)
            });
        });
    }

    for (const f of cluster) {
        const i0 = index.getX(f * 3 + 0);
        const i1 = index.getX(f * 3 + 1);
        const i2 = index.getX(f * 3 + 2);

        [i0, i1, i2].forEach((i) => {
            colors.setX(i, color.r);
            colors.setY(i, color.g);
            colors.setZ(i, color.b);
            colors.setW(i, opacity);
        });
    }

    colors.needsUpdate = true;

    if (recordHistory) {
        undoStack.push({
            type: "facePaint",
            mesh,
            cluster,
            previousColors,
            newColor: color.clone(),
            newOpacity: opacity
        });

        redoStack.length = 0;
    }
}


// ------------------------------------------------------------
// Edge painting
// ------------------------------------------------------------

function paintEdgeStyle(mesh, cluster, style, recordHistory = true) {
    const clusters = mesh.userData.surfaceClusters;
    const clusterIndex = clusters.indexOf(cluster);
    if (clusterIndex === -1) return;

    const meshStyles = edgeStyles.get(mesh);
    const prev = meshStyles.get(clusterIndex) || {
        color: new THREE.Color(0x000000),
        width: 1,
        dashed: false,
    };

    if (recordHistory) {
        undoStack.push({
            type: "edgeStyle",
            mesh,
            cluster,
            previous: {
                color: prev.color.clone(),
                width: prev.width,
                dashed: prev.dashed,
                dashScale: prev.dashScale ?? 1
            },
            next: {
                color: style.color.clone(),
                width: style.width,
                dashed: style.dashed,
                dashScale: style.dashScale
            }
        });
        redoStack.length = 0;
    }

    meshStyles.set(clusterIndex, {
        color: style.color.clone(),
        width: style.width,
        dashed: style.dashed,
        dashScale: style.dashScale
    });

    updatePersistentEdgeLinesForCluster(mesh, cluster, style);
}

// ------------------------------------------------------------
// Selection highlight (boundary-only, same logic as thick lines)
// ------------------------------------------------------------

function highlightFace(hit) {
    const clusters = hit.object.userData.surfaceClusters;
    if (!clusters) return;

    const faceIndex = hit.faceIndex;
    if (faceIndex == null) return;

    const cluster = clusters.find((c) => c.includes(faceIndex));
    if (!cluster) return;

    deselectAllFaces();

    currentSelectedMesh = hit.object;
    currentSelectedCluster = cluster;

    if (pickMode) {
        loadFacePropertiesFromCluster(hit.object, cluster);
        loadEdgeStyleIntoUI(hit.object, cluster);
    }

    const color = new THREE.Color(colorInput.value);
    const opacity = parseFloat(opacityInput.value);

    const style = {
        color: new THREE.Color(edgeColorInput.value),
        width: parseFloat(edgeWidthInput.value),
        dashed: edgeDashedInput.checked,
        dashScale: parseFloat(edgeDashScaleInput.value)
    };

    if (!pickMode) {
        paintCluster(hit.object, cluster, color, opacity);
        paintEdgeStyle(currentSelectedMesh, currentSelectedCluster, style);
    }

    const geometry = hit.object.geometry;

    if (boundaryEdges) {
        scene.remove(boundaryEdges);
        boundaryEdges.geometry.dispose();
        boundaryEdges.material.dispose();
        boundaryEdges = null;
    }

    const edgeAttr = getBoundaryEdges(geometry, cluster);

    if (edgeAttr.count > 0) {
        const boundaryGeo = new THREE.BufferGeometry();
        boundaryGeo.setAttribute("position", edgeAttr);

        const boundaryMat = new THREE.LineBasicMaterial({
            color: 0xff0000,
            linewidth: 1
        });

        boundaryEdges = new THREE.LineSegments(boundaryGeo, boundaryMat);

        boundaryEdges.applyMatrix4(hit.object.matrixWorld);
        boundaryEdges.material.depthTest = false;
        boundaryEdges.material.depthWrite = false;
        boundaryEdges.renderOrder = 999;

        boundaryEdges.layers.set(HIGHLIGHT_LAYER);
        scene.add(boundaryEdges);
        boundaryEdges.raycast = () => {};
    }
}

function deselectAllFaces() {
    if (boundaryEdges) {
        scene.remove(boundaryEdges);
        boundaryEdges.geometry.dispose();
        boundaryEdges.material.dispose();
        boundaryEdges = null;
    }

    currentSelectedMesh = null;
    currentSelectedCluster = null;
}


// ------------------------------------------------------------
// Undo / Redo
// ------------------------------------------------------------

function undo() {
    if (undoStack.length === 0) return;

    const op = undoStack.pop();

    if (op.type === "facePaint") {
        const geo = op.mesh.geometry;
        const colors = geo.attributes.color;

        op.previousColors.forEach((p) => {
            colors.setX(p.index, p.r);
            colors.setY(p.index, p.g);
            colors.setZ(p.index, p.b);
            colors.setW(p.index, p.a);
        });

        colors.needsUpdate = true;
    }

    if (op.type === "edgeStyle") {
        paintEdgeStyle(op.mesh, op.cluster, op.previous, false);
    }

    redoStack.push(op);
}

function redo() {
    if (redoStack.length === 0) return;

    const op = redoStack.pop();

    if (op.type === "facePaint") {
        paintCluster(op.mesh, op.cluster, op.newColor, op.newOpacity, false);
    }

    if (op.type === "edgeStyle") {
        paintEdgeStyle(op.mesh, op.cluster, op.next, false);
    }

    undoStack.push(op);
}


// ------------------------------------------------------------
// UI helpers
// ------------------------------------------------------------

function loadFacePropertiesFromCluster(mesh, cluster) {
    const geo = mesh.geometry;
    const colors = geo.attributes.color;
    const index = geo.index;

    const f = cluster[0];
    const i0 = index.getX(f * 3 + 0);

    const r = colors.getX(i0);
    const g = colors.getY(i0);
    const b = colors.getZ(i0);
    const a = colors.getW(i0);

    const hex = new THREE.Color(r, g, b).getHexString();

    colorInput.value = `#${hex}`;
    opacityInput.value = a;
}

function loadEdgeStyleIntoUI(mesh, cluster) {
    const meshStyles = edgeStyles.get(mesh);
    const clusterIndex = mesh.userData.surfaceClusters.indexOf(cluster);
    const style = meshStyles.get(clusterIndex);
    if (!style) return;

    edgeColorInput.value = "#" + style.color.getHexString();
    edgeWidthInput.value = style.width;
    edgeDashScaleInput.value = style.dashScale ?? 1;
    edgeDashedInput.checked = style.dashed;
}


// ------------------------------------------------------------
// UI event wiring
// ------------------------------------------------------------

function applyUIFacePaint() {
    if (!currentSelectedMesh || !currentSelectedCluster) return;

    const color = new THREE.Color(colorInput.value);
    const opacity = parseFloat(opacityInput.value);

    paintCluster(currentSelectedMesh, currentSelectedCluster, color, opacity);
}

colorInput.addEventListener("input", applyUIFacePaint);
opacityInput.addEventListener("input", applyUIFacePaint);

function applyUIEdgeStyle() {
    if (!currentSelectedMesh || !currentSelectedCluster) return;

    const style = {
        color: new THREE.Color(edgeColorInput.value),
        width: parseFloat(edgeWidthInput.value),
        dashed: edgeDashedInput.checked,
        dashScale: parseFloat(edgeDashScaleInput.value)
    };

    paintEdgeStyle(currentSelectedMesh, currentSelectedCluster, style);
}

edgeColorInput.addEventListener("input", applyUIEdgeStyle);
edgeWidthInput.addEventListener("input", applyUIEdgeStyle);
edgeDashScaleInput.addEventListener("input", applyUIEdgeStyle);
edgeDashedInput.addEventListener("change", applyUIEdgeStyle);

if (colorPanel) {
    colorPanel.addEventListener("pointerdown", (e) => e.stopPropagation());
    colorPanel.addEventListener("pointerup", (e) => e.stopPropagation());
}

// ------------------------------------------------------------
// Pointer + keyboard handling
// ------------------------------------------------------------

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

    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
});

window.addEventListener("pointerup", (e) => {
    pointerDown = false;
    if (moved) return;

    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, activeCamera);

    activeCamera.layers.set(0);
    const intersects = raycaster.intersectObjects(scene.children, true);
    activeCamera.layers.enableAll();

    if (intersects.length > 0) {
        highlightFace(intersects[0]);
    } else {
        deselectAllFaces();
    }
});

window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "z") undo();
    if (e.ctrlKey && e.key === "y") redo();
    if (e.key === "p") pickMode = true;
    if (e.key === "Escape") deselectAllFaces();
});

window.addEventListener("keyup", (e) => {
    if (e.key === "p") pickMode = false;
});


// ------------------------------------------------------------
// Resize
// ------------------------------------------------------------

function updateAllLineResolutions() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Iterate over all meshes in the scene
    scene.traverse((child) => {
        if (!child.isMesh) return;

        const clusterMap = persistentEdgeLines.get(child);
        if (!clusterMap) return;

        // clusterMap is a normal Map → iterable
        for (const [clusterIndex, line] of clusterMap) {
            if (line?.material?.resolution) {
                line.material.resolution.set(w, h);
            }
        }
    });
}


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

    updateAllLineResolutions();
});


// ------------------------------------------------------------
// Clustering
// ------------------------------------------------------------

function buildAdjacency(geometry) {
    const index = geometry.index;
    const faces = index.count / 3;

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

    const adjacency = Array.from({ length: faces }, () => []);

    for (const [, faceList] of edgeMap.entries()) {
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
    const faces = adjacency.length;

    const visited = new Array(faces).fill(false);
    const clusters = [];

    const angleThreshold = Math.cos(
        THREE.MathUtils.degToRad(angleThresholdDeg)
    );

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

// ------------------------------------------------------------
// Camera toggle (optional UI hook)
// ------------------------------------------------------------

function toggleCameraMode() {
    if (activeCamera === camera) {
        orthoCamera.position.copy(camera.position);
        orthoCamera.quaternion.copy(camera.quaternion);
        activeCamera = orthoCamera;
    } else {
        camera.position.copy(orthoCamera.position);
        camera.quaternion.copy(orthoCamera.quaternion);
        activeCamera = camera;
    }
    controls.object = activeCamera;
    controls.update();
}


// ------------------------------------------------------------
// Main loop
// ------------------------------------------------------------

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, activeCamera);
}
animate();
