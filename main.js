// TO DO:
    // Output/Export high res render
        // Smooth geometry. Crisp lines.
        // Render on button press. Show rendered image below main canvas
        // Export SVG?
    // Paint all faces upon initial load (eliminate weird artifacts in the default state that are not present in painted state...)
    // Generate axis line?
    // Snap to ortho views with keys (front/side/top)?
    // Add back a pick-mode button to UI (for mobile)
    // Multi face select
    // Select entire mesh
    // Select individual edges?

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
// document.body.appendChild(renderer.domElement);
document.getElementById("viewerContainer").appendChild(renderer.domElement);


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
    depthWrite: true,
    depthTest: false
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
    initializeModel(obj)
});

function computeFaceData(geometry) {
    const index = geometry.index;
    const pos = geometry.attributes.position;
    const faceCount = index.count / 3;

    const centroids = new Array(faceCount);
    const normals   = new Array(faceCount);

    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const v2 = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();

    for (let f = 0; f < faceCount; f++) {
        const i0 = index.getX(f * 3 + 0);
        const i1 = index.getX(f * 3 + 1);
        const i2 = index.getX(f * 3 + 2);

        v0.fromBufferAttribute(pos, i0);
        v1.fromBufferAttribute(pos, i1);
        v2.fromBufferAttribute(pos, i2);

        const c = new THREE.Vector3()
            .addVectors(v0, v1)
            .add(v2)
            .multiplyScalar(1 / 3);

        e1.subVectors(v1, v0);
        e2.subVectors(v2, v0);
        const n = new THREE.Vector3().crossVectors(e1, e2).normalize();

        centroids[f] = c;
        normals[f]   = n;
    }

    return { centroids, normals };
}

function computePrincipalAxis(centroids, faceIndices) {
    if (faceIndices.length === 0) return null;

    const mean = new THREE.Vector3();
    for (const f of faceIndices) {
        mean.add(centroids[f]);
    }
    mean.multiplyScalar(1 / faceIndices.length);

    // Covariance matrix of centroids
    let xx = 0, xy = 0, xz = 0;
    let yy = 0, yz = 0, zz = 0;

    for (const f of faceIndices) {
        const p = centroids[f];
        const x = p.x - mean.x;
        const y = p.y - mean.y;
        const z = p.z - mean.z;

        xx += x * x;
        xy += x * y;
        xz += x * z;
        yy += y * y;
        yz += y * z;
        zz += z * z;
    }

    // Power iteration for dominant eigenvector
    let v = new THREE.Vector3(1, 0, 0).normalize();
    for (let iter = 0; iter < 15; iter++) {
        const x = v.x, y = v.y, z = v.z;

        const nx = xx * x + xy * y + xz * z;
        const ny = xy * x + yy * y + yz * z;
        const nz = xz * x + yz * y + zz * z;

        v.set(nx, ny, nz);
        if (v.lengthSq() === 0) break;
        v.normalize();
    }

    return { origin: mean, dir: v.normalize() };
}

function mergeRingClusters(geometry, clusters) {
    const { centroids } = computeFaceData(geometry);

    // Compute average radius for each cluster
    const clusterInfo = clusters.map((cluster) => {
        const axis = computePrincipalAxis(centroids, cluster);
        if (!axis) return null;

        const { origin, dir } = axis;
        const radii = [];

        const tmp = new THREE.Vector3();
        const proj = new THREE.Vector3();

        for (const f of cluster) {
            const c = centroids[f];
            tmp.subVectors(c, origin);
            const t = tmp.dot(dir);
            proj.copy(dir).multiplyScalar(t).add(origin);
            radii.push(c.distanceTo(proj));
        }

        const avg = radii.reduce((a, b) => a + b, 0) / radii.length;
        const variance = radii.reduce((a, r) => a + (r - avg) * (r - avg), 0) / radii.length;

        return { cluster, avgRadius: avg, variance, axis };
    });

    const merged = new Array(clusters.length).fill(false);
    const result = [];

    const REL_RADIUS_EPS = 0.05; // 5% tolerance

    for (let i = 0; i < clusterInfo.length; i++) {
        if (merged[i] || !clusterInfo[i]) continue;

        const base = clusterInfo[i];
        const mergedFaces = new Set(base.cluster);

        for (let j = i + 1; j < clusterInfo.length; j++) {
            if (merged[j] || !clusterInfo[j]) continue;

            const other = clusterInfo[j];

            // Compare radii (relative)
            const maxR = Math.max(base.avgRadius, other.avgRadius);
            if (maxR === 0) continue;

            const relDiff = Math.abs(base.avgRadius - other.avgRadius) / maxR;
            if (relDiff > REL_RADIUS_EPS) continue;

            // Radii match → treat as same ring
            other.cluster.forEach(f => mergedFaces.add(f));
            merged[j] = true;
        }

        result.push(Array.from(mergedFaces));
        merged[i] = true;
    }

    return result;
}

function mergeCylindricalClusters(geometry, clusters) {
    const { centroids, normals } = computeFaceData(geometry);

    const cylInfos = clusters
        .map((c, idx) => ({ idx, info: analyzeClusterAsCylinder(geometry, centroids, normals, c) }))
        .filter(x => x.info);

    if (cylInfos.length < 2) return clusters;

    // Sort by radius (just in case)
    cylInfos.sort((a,b) => a.info.radius - b.info.radius);

    // Merge all cylinders with same radius
    const mergedFaces = new Set();
    const baseR = cylInfos[0].info.radius;

    for (const { idx, info } of cylInfos) {
        if (Math.abs(info.radius - baseR) < baseR * 0.01) {
            clusters[idx].forEach(f => mergedFaces.add(f));
        }
    }

    // Build final cluster list
    const result = [];
    const mergedSet = new Set(cylInfos.map(x => x.idx));

    result.push(Array.from(mergedFaces));

    clusters.forEach((c, idx) => {
        if (!mergedSet.has(idx)) result.push(c);
    });

    return result;
}
function analyzeClusterAsCylinder(geometry, centroids, normals, cluster) {
    if (cluster.length < 8) return null; // too small

    const axis = computePrincipalAxis(centroids, cluster);
    if (!axis) return null;

    const { origin, dir } = axis;

    let radii = [];
    let normalPerpSum = 0;

    const tmp = new THREE.Vector3();
    const proj = new THREE.Vector3();
    const radial = new THREE.Vector3();

    for (const f of cluster) {
        const c = centroids[f];
        const n = normals[f];

        // distance from axis
        tmp.subVectors(c, origin);
        const t = tmp.dot(dir);
        proj.copy(dir).multiplyScalar(t).add(origin);
        const r = c.distanceTo(proj);
        radii.push(r);

        // normals perpendicular to axis?
        const perp = 1 - Math.abs(n.dot(dir));
        normalPerpSum += perp;
    }

    const avgR = radii.reduce((a,b)=>a+b,0) / radii.length;
    const varR = radii.reduce((a,r)=>a+(r-avgR)*(r-avgR),0) / radii.length;
    const normalPerp = normalPerpSum / cluster.length;

    // Cylinder rules
    if (normalPerp < 0.25) return null;          // normals must be perpendicular
    if (avgR < 0.05) return null;               // exclude fillets
    if (varR > avgR * 0.01) return null;        // radius must be consistent

    return {
        origin,
        dir,
        radius: avgR,
        variance: varR,
        normalPerp,
        faces: cluster
    };
}

function initializeModel(obj) {
    obj.traverse((child) => {
        if (child.isMesh) {
            child.geometry.deleteAttribute("normal");
            child.geometry = mergeVertices(child.geometry);
            child.geometry.computeVertexNormals();

            // child.userData.surfaceClusters = buildSurfaceClusters(
            //     child.geometry,
            //     179
            // );

            let clusters = buildSurfaceClusters(child.geometry, 179);
            clusters = mergeCylindricalClusters(child.geometry, clusters);
            child.userData.surfaceClusters = clusters;

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
            child.material.depthWrite = true,
            child.material.depthTest = true

            edgeStyles.set(child, new Map());
            persistentEdgeLines.set(child, new Map());

            const defaultStyle = {
                color: new THREE.Color("#000000"),
                width: 1,
                dashed: false,
                dashScale: 1
            };

            const meshStyles = edgeStyles.get(child);
            const meshLines = persistentEdgeLines.get(child);

            child.userData.surfaceClusters.forEach((cluster, clusterIndex) => {
                meshStyles.set(clusterIndex, {
                    color: defaultStyle.color.clone(),
                    width: defaultStyle.width,
                    dashed: defaultStyle.dashed,
                    dashScale: defaultStyle.dashScale
                });

                updatePersistentEdgeLinesForCluster(child, cluster, defaultStyle);
            });
        }
    });

    scene.add(obj);
    currentModel = obj;
}

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

    const edgeAttr = getBoundaryEdges(mesh.geometry, cluster);
    if (edgeAttr.count === 0) {
        meshLines.delete(clusterIndex);
        return;
    }

    const geo = new LineSegmentsGeometry();
    geo.setPositions(edgeAttr.array);

    const mat = new LineMaterial({
        color: style.color.getHex(),
        linewidth: style.width * window.devicePixelRatio,
        dashed: style.dashed,
        dashSize: 1 * style.dashScale,
        gapSize: 1 * style.dashScale
    });

    mat.resolution.set(window.innerWidth, window.innerHeight);

    mat.depthTest = true;
    mat.depthWrite = true;
    mat.polygonOffset = false;

    // Inject user‑controlled depth bias
    mat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace(
            'gl_Position = clip;',
            `
            gl_Position = clip;
            gl_Position.z -= ${edgeDepthBias} * gl_Position.w;
            `
        );
    };

    const line = new LineSegments2(geo, mat);
    line.computeLineDistances();
    line.applyMatrix4(mesh.matrixWorld);

    line.renderOrder = mesh.renderOrder + 1;
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
    if (e.target !== renderer.domElement) return; // ignore clicks outside of canvas

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
// OBJ File Loading
// ------------------------------------------------------------

// document.getElementById("fileInput").addEventListener("change", async (event) => {
//     const file = event.target.files[0];
//     if (!file) return;

//     const text = await file.text(); // read OBJ as string
//     handleOBJLoad(text, file.name);
// });

// Drag & drop support
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
    e.preventDefault();

    const file = e.dataTransfer.files[0];
    if (!file || !file.name.toLowerCase().endsWith(".obj")) return;

    const text = await file.text();
    handleOBJLoad(text, file.name);
});

function handleOBJLoad(objText, name) {

    // If a model is already loaded, ask user what to do
    if (currentModel) {
        const replace = confirm(
            "A model is already loaded.\n\nDo you want to remove it before loading the new one?"
        );

        if (replace) {
            // Remove old model from scene
            scene.remove(currentModel);
            currentModel.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    if (Array.isArray(obj.material)) {
                        obj.material.forEach(m => m.dispose());
                    } else {
                        obj.material.dispose();
                    }
                }
            });
            currentModel = null;

            currentEdgeLayers.forEach(layer => {
                scene.remove(layer);
                if (layer.geometry) layer.geometry.dispose();
                if (layer.material) layer.material.dispose();
            });
            currentEdgeLayers = [];
        }
    }

    // Load new OBJ
    loadOBJFromString(objText, name);
    }

// Core OBJ loading logic
function loadOBJFromString(objText, name = "model.obj") {
    const object = loader.parse(objText);
    object.name = name;

    // Normalize geometry
    object.traverse((child) => {
        if (child.isMesh) {
            child.geometry.computeVertexNormals();
        }
    });

    // Add to scene
    scene.add(object);

    // Hand off to your existing pipeline
    if (typeof initializeModel === "function") {
        initializeModel(object);
    }
    // console.log(currentModel)
}

//
// ------------------------------------------------------------
// High‑Resolution Snapshot Renderer
// ------------------------------------------------------------

const snapshotRenderer = new THREE.WebGLRenderer({ antialias: true });
snapshotRenderer.setPixelRatio(1); // we control resolution manually

// How many times bigger than the live view?
const SNAPSHOT_SCALE = 2;

// Render button
document.getElementById("renderButton").addEventListener("click", () => {
    if (!currentModel) return;

    // Compute target resolution
    const w = renderer.domElement.width * SNAPSHOT_SCALE;
    const h = renderer.domElement.height * SNAPSHOT_SCALE;

    snapshotRenderer.setSize(w, h, false);

    // Render scene using the active camera
    snapshotRenderer.render(scene, activeCamera);

    // Convert to PNG
    const dataURL = snapshotRenderer.domElement.toDataURL("image/png");

    // Display in preview box
    const img = document.getElementById("renderOutput");
    img.src = dataURL;

    // Store for saving
    window.lastRenderDataURL = dataURL;
});

// Save button
document.getElementById("saveRenderButton").addEventListener("click", () => {
    if (!window.lastRenderDataURL) return;

    const a = document.createElement("a");
    a.href = window.lastRenderDataURL;
    a.download = "render.png";
    a.click();
});

//
function exportSVG() {
    if (!currentModel) return;

    const width  = renderer.domElement.width;
    const height = renderer.domElement.height;

    const meshes = [];
    currentModel.traverse(o => { if (o.isMesh) meshes.push(o); });

    const svgPaths = [];

    // ------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------

    function projectToScreen(v) {
        const p = v.clone().project(activeCamera);
        return [
            (p.x * 0.5 + 0.5) * width,
            (1 - (p.y * 0.5 + 0.5)) * height
        ];
    }

    function faceNormalCamSpace(a, b, c, mvMatrix) {
        const v0 = a.clone().applyMatrix4(mvMatrix);
        const v1 = b.clone().applyMatrix4(mvMatrix);
        const v2 = c.clone().applyMatrix4(mvMatrix);

        return v1.sub(v0).cross(v2.sub(v0)).normalize();
    }

    // ------------------------------------------------------------
    // Main
    // ------------------------------------------------------------

    for (const mesh of meshes) {
        const clusters = mesh.userData.surfaceClusters;
        if (!clusters) continue;

        const geo    = mesh.geometry;
        const pos    = geo.attributes.position;
        const index  = geo.index;
        const colors = geo.attributes.color;

        if (!index) continue;

        const triCount = index.count / 3;

        // Build adjacency: edge → [faceA, faceB]
        const edgeMap = new Map();
        function addEdge(a, b, f) {
            const key = a < b ? `${a}_${b}` : `${b}_${a}`;
            if (!edgeMap.has(key)) edgeMap.set(key, []);
            edgeMap.get(key).push(f);
        }

        for (let f = 0; f < triCount; f++) {
            const i0 = index.getX(f*3+0);
            const i1 = index.getX(f*3+1);
            const i2 = index.getX(f*3+2);
            addEdge(i0, i1, f);
            addEdge(i1, i2, f);
            addEdge(i2, i0, f);
        }

        // Precompute face normals in camera space
        const mvMatrix = new THREE.Matrix4()
            .multiplyMatrices(activeCamera.matrixWorldInverse, mesh.matrixWorld);

        const faceNormals = [];
        const faceCenters = [];

        for (let f = 0; f < triCount; f++) {
            const i0 = index.getX(f*3+0);
            const i1 = index.getX(f*3+1);
            const i2 = index.getX(f*3+2);

            const v0 = new THREE.Vector3().fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
            const v1 = new THREE.Vector3().fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
            const v2 = new THREE.Vector3().fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);

            const n = faceNormalCamSpace(
                new THREE.Vector3().fromBufferAttribute(pos, i0),
                new THREE.Vector3().fromBufferAttribute(pos, i1),
                new THREE.Vector3().fromBufferAttribute(pos, i2),
                mvMatrix
            );

            faceNormals[f] = n;

            const c = v0.clone().add(v1).add(v2).multiplyScalar(1/3);
            faceCenters[f] = c;
        }

        // Determine if face is front-facing
        const faceFacing = faceNormals.map(n => n.z < 0);

        // For each cluster, collect silhouette edges
        clusters.forEach((cluster, clusterIndex) => {
            const style = edgeStyles.get(mesh)?.get(clusterIndex);
            if (!style) return;

            // Face color
            const f0 = cluster[0];
            const i0 = index.getX(f0*3+0);
            const lr = colors.getX(i0);
            const lg = colors.getY(i0);
            const lb = colors.getZ(i0);
            const a  = colors.getW(i0);

            const srgb = new THREE.Color(lr, lg, lb).convertLinearToSRGB();
            const fillColor   = `rgb(${Math.round(srgb.r*255)},${Math.round(srgb.g*255)},${Math.round(srgb.b*255)})`;
            const fillOpacity = a;

            const silhouetteSegments = [];

            for (const [key, faces] of edgeMap.entries()) {
                const [s0, s1] = key.split("_").map(Number);

                const facesInCluster = faces.filter(f => cluster.includes(f));
                if (facesInCluster.length === 0) continue;

                let isSilhouette = false;

                if (faces.length === 1) {
                    // True mesh boundary
                    isSilhouette = true;
                } else if (faces.length === 2) {
                    const [fA, fB] = faces;
                    const A = faceFacing[fA];
                    const B = faceFacing[fB];

                    if (facesInCluster.length === 1) {
                        // Edge between this cluster and some other cluster → feature edge
                        isSilhouette = true;
                    } else {
                        // Both faces in this cluster → true silhouette only if facing differs
                        if (A !== B) isSilhouette = true;
                    }
                }

                if (isSilhouette) {
                    const v1 = new THREE.Vector3().fromBufferAttribute(pos, s0).applyMatrix4(mesh.matrixWorld);
                    const v2 = new THREE.Vector3().fromBufferAttribute(pos, s1).applyMatrix4(mesh.matrixWorld);
                    silhouetteSegments.push([v1, v2]);
                }
            }


            if (!silhouetteSegments.length) return;

            // Build loops
            const loops = buildOrderedLoops(silhouetteSegments);
            if (!loops || !loops.length) return;

            // Project loops
            let d = "";
            for (const loop of loops) {
                const pts = loop.map(v => projectToScreen(v));
                d += pts.map((p,i) => (i===0 ? `M ${p[0]},${p[1]}` : `L ${p[0]},${p[1]}`)).join(" ");
                d += " Z ";
            }

            // Emit path
            svgPaths.push(`
                <path d="${d}"
                      fill="${fillColor}"
                      fill-opacity="${fillOpacity}"
                      stroke="${style.color.getStyle()}"
                      stroke-width="${style.width}"
                      ${style.dashed ? `stroke-dasharray="${style.dashScale*70}"` : ""}
                      fill-rule="evenodd"
                />
            `);
        });
    }

    return `
        <svg xmlns="http://www.w3.org/2000/svg"
             width="${width}" height="${height}"
             viewBox="0 0 ${width} ${height}">
            ${svgPaths.join("\n")}
        </svg>
    `;
}

function buildOrderedLoops(segments) {
    const adj = new Map();
    const pointMap = new Map();

    function key(v) {
        return `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
    }

    for (const [a, b] of segments) {
        const ka = key(a), kb = key(b);

        if (!adj.has(ka)) adj.set(ka, []);
        if (!adj.has(kb)) adj.set(kb, []);

        adj.get(ka).push(kb);
        adj.get(kb).push(ka);

        pointMap.set(ka, a);
        pointMap.set(kb, b);
    }

    const loops = [];
    const visitedEdges = new Set();

    function edgeKey(a, b) { return `${a}|${b}`; }

    function walkLoop(startKey) {
        const loop = [];
        let current = startKey;

        while (true) {
            const v = pointMap.get(current);
            if (!v) break;
            loop.push(v);

            const neighbors = adj.get(current);
            if (!neighbors || neighbors.length === 0) break;

            let next = null;
            for (const nb of neighbors) {
                const ek = edgeKey(current, nb);
                if (!visitedEdges.has(ek)) {
                    visitedEdges.add(ek);
                    visitedEdges.add(edgeKey(nb, current));
                    next = nb;
                    break;
                }
            }

            if (!next) break;
            current = next;
            if (current === startKey) break;
        }

        return loop;
    }

    for (const [a, neighbors] of adj.entries()) {
        for (const b of neighbors) {
            const ek = edgeKey(a, b);
            if (!visitedEdges.has(ek)) {
                visitedEdges.add(ek);
                visitedEdges.add(edgeKey(b, a));
                const loop = walkLoop(a);
                if (loop.length > 2) loops.push(loop);
            }
        }
    }

    return loops;
}

function loopSignature(loop) {
    const pts = loop.map(v => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`);
    pts.sort();
    return pts.join("|");
}


document.getElementById("saveSVGButton").addEventListener("click", () => {
    const svg = exportSVG();
    if (!svg) return;

    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "modelSVG.svg";
    a.click();

    URL.revokeObjectURL(url);
});

document.getElementById("edgeBias").addEventListener("input", (e) => {
    edgeDepthBias = parseFloat(e.target.value);

    // Rebuild all persistent edge lines with the new bias
    if (currentModel) {
        currentModel.traverse(obj => {
            if (obj.isMesh) {
                const clusters = obj.userData.surfaceClusters;
                if (!clusters) return;

                clusters.forEach(cluster => {
                    const style = edgeStyles.get(obj).get(clusters.indexOf(cluster));
                    updatePersistentEdgeLinesForCluster(obj, cluster, style);
                });
            }
        });
    }
});



// ------------------------------------------------------------
// Main loop
// ------------------------------------------------------------

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, activeCamera);
}
animate();
