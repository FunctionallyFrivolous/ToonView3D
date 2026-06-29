// TO DO:
    // Generate axis line? Offset faces?
    // Camera Views
        // Snap to ortho views 
        // Save camera view
    // High res render Improvements
        // Smooth geometry
    // UI Improvements
        // Selection Modes
            // Add multi select
    // BACK BURNER:
        // SVG export
            // Just need silhouette edges to work right...

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
// Globals
// ------------------------------------------------------------

let boundaryEdges = null;

const HIGHLIGHT_LAYER = 2;

let currentSelectedMesh = null;
let currentSelectedCluster = null;

let currentSelectedEdge = null; // { mesh, cluster, edgeIndex, p1, p2 }
let edgeHighlightLine = null;   // LineSegments2 for selected edge

const undoStack = [];
const redoStack = [];

let pickMode = false;

let meshMode = false;
let edgeMode = false;

let pointerDown = false;
let moved = false;
let downX = 0;
let downY = 0;

let currentModel = null;

let edgeDepthBias = 0.0001;

const globalEdgeMap = new Map();

const parentToClusters = new WeakMap();



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
renderer.getContext().getExtension("EXT_frag_depth");

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

const edgeStyles = new WeakMap();          // mesh → Map(clusterIndex → style)
const persistentEdgeLines = new WeakMap(); // mesh → Map(clusterIndex → LineSegments2)
const edgeOverrides = new WeakMap();       // mesh → Map(clusterIndex → Map(edgeIndex → style))

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
    initializeModel(obj);
});

// ------------------------------------------------------------
// Cluster mesh builder
// ------------------------------------------------------------

function buildClusterMesh(parentMesh, cluster) {
    const srcGeo = parentMesh.geometry;
    const index = srcGeo.index;
    const pos = srcGeo.attributes.position;
    const col = srcGeo.attributes.color;

    const newPositions = [];
    const newColors = [];
    const newIndices = [];

    const vertexMap = new Map();
    let nextIndex = 0;

    function useVertex(oldIndex) {
        if (vertexMap.has(oldIndex)) return vertexMap.get(oldIndex);

        const i = nextIndex++;
        vertexMap.set(oldIndex, i);

        newPositions.push(
            pos.getX(oldIndex),
            pos.getY(oldIndex),
            pos.getZ(oldIndex)
        );

        newColors.push(
            col.getX(oldIndex),
            col.getY(oldIndex),
            col.getZ(oldIndex),
            col.getW(oldIndex)
        );

        return i;
    }

    for (const f of cluster) {
        const a = index.getX(f * 3 + 0);
        const b = index.getX(f * 3 + 1);
        const c = index.getX(f * 3 + 2);

        const na = useVertex(a);
        const nb = useVertex(b);
        const nc = useVertex(c);

        newIndices.push(na, nb, nc);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(newPositions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(newColors, 4));
    geo.setIndex(newIndices);
    geo.computeVertexNormals();

    return geo;
}

function canonicalEdgeKey(p1, p2) {
    const a = `${p1.x.toFixed(6)},${p1.y.toFixed(6)},${p1.z.toFixed(6)}`;
    const b = `${p2.x.toFixed(6)},${p2.y.toFixed(6)},${p2.z.toFixed(6)}`;
    return (a < b) ? `${a}|${b}` : `${b}|${a}`;
}


// ------------------------------------------------------------
// Model initialization (split into per-cluster meshes)
// ------------------------------------------------------------

function initializeModel(obj) {
    const newGroup = new THREE.Group();

    obj.traverse((child) => {
        if (!child.isMesh) return;

        child.geometry = mergeVertices(child.geometry);
        child.geometry.computeVertexNormals();

        // create color attribute BEFORE clustering/splitting
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

        const clusters = buildSurfaceClusters(child.geometry, 179);

        clusters.forEach((cluster, clusterIndex) => {
            const clusterGeo = buildClusterMesh(child, cluster);

            const mat = defaultFaceMaterial.clone();
            mat.vertexColors = true;
            mat.transparent = true;
            mat.depthTest = true;
            mat.depthWrite = false;

            const clusterMesh = new THREE.Mesh(clusterGeo, mat);

            if (!parentToClusters.has(child)) {
                parentToClusters.set(child, []);
            }
            parentToClusters.get(child).push(clusterMesh);


            // Local cluster: faces 0..cluster.length-1 in this new geometry
            const localCluster = Array.from({ length: cluster.length }, (_, i) => i);

            clusterMesh.userData.cluster = localCluster;
            clusterMesh.userData.clusterIndex = clusterIndex;
            clusterMesh.userData.parentMesh = child;

            newGroup.add(clusterMesh);

            edgeStyles.set(clusterMesh, new Map());
            persistentEdgeLines.set(clusterMesh, new Map());
            edgeOverrides.set(clusterMesh, new Map());

            const defaultStyle = {
                color: new THREE.Color("#000000"),
                width: 1,
                dashed: false,
                dashScale: 1
            };

            edgeStyles.get(clusterMesh).set(clusterIndex, {
                color: defaultStyle.color.clone(),
                width: defaultStyle.width,
                dashed: defaultStyle.dashed,
                dashScale: defaultStyle.dashScale
            });

            // IMPORTANT: pass localCluster here, not the original cluster
            updatePersistentEdgeLinesForCluster(clusterMesh, localCluster, defaultStyle);
        });
    });

    scene.add(newGroup);
    currentModel = newGroup;
}

// ------------------------------------------------------------
// Single-edge style override
// ------------------------------------------------------------

function setSingleEdgeStyle(mesh, clusterIndex, edgeIndex, style) {
    let meshOverrides = edgeOverrides.get(mesh);
    if (!meshOverrides) {
        meshOverrides = new Map();
        edgeOverrides.set(mesh, meshOverrides);
    }

    let clusterOverrides = meshOverrides.get(clusterIndex);
    if (!clusterOverrides) {
        clusterOverrides = new Map();
        meshOverrides.set(clusterIndex, clusterOverrides);
    }

    clusterOverrides.set(edgeIndex, {
        color: style.color.clone(),
        width: style.width,
        dashed: style.dashed,
        dashScale: style.dashScale
    });
}

// ------------------------------------------------------------
// Boundary-only edge extraction
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
// Persistent fat-line edges (per-cluster meshes)
// ------------------------------------------------------------

function updatePersistentEdgeLinesForCluster(mesh, cluster, clusterStyle) {
    const clusterIndex = mesh.userData.clusterIndex;
    if (clusterIndex == null) return;

    const meshLines = persistentEdgeLines.get(mesh);
    const meshOverrides = edgeOverrides.get(mesh);
    const clusterOverrides = meshOverrides ? meshOverrides.get(clusterIndex) : null;

    // Remove existing lines for this cluster
    const existing = meshLines.get(clusterIndex);
    if (existing) {
        existing.forEach(line => {
            scene.remove(line);
            line.geometry.dispose();
            line.material.dispose();
        });
    }

    // Remove existing entries for this mesh+cluster from globalEdgeMap
    for (const [key, list] of globalEdgeMap.entries()) {
        const filtered = list.filter(e => !(e.mesh === mesh && e.clusterIndex === clusterIndex));
        if (filtered.length === 0) {
            globalEdgeMap.delete(key);
        } else if (filtered.length !== list.length) {
            globalEdgeMap.set(key, filtered);
        }
    }

    const newLines = [];

    const edgeAttr = getBoundaryEdges(mesh.geometry, cluster);
    const arr = edgeAttr.array;

    for (let i = 0; i < arr.length; i += 6) {
        const edgeIndex = i / 6;
        const s = clusterOverrides && clusterOverrides.get(edgeIndex) || clusterStyle;

        const geo = new LineSegmentsGeometry();
        geo.setPositions([
            arr[i + 0], arr[i + 1], arr[i + 2],
            arr[i + 3], arr[i + 4], arr[i + 5]
        ]);

        const mat = new LineMaterial({
            color: s.color.getHex(),
            linewidth: s.width * window.devicePixelRatio,
            dashed: s.dashed,
            dashSize: 1 * s.dashScale,
            gapSize: 1 * s.dashScale
        });

        mat.resolution.set(window.innerWidth, window.innerHeight);

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

        scene.add(line);
        newLines.push(line);

        // Register this edge in the global twin map (world-space)
        const p1 = new THREE.Vector3(arr[i + 0], arr[i + 1], arr[i + 2]).applyMatrix4(mesh.matrixWorld);
        const p2 = new THREE.Vector3(arr[i + 3], arr[i + 4], arr[i + 5]).applyMatrix4(mesh.matrixWorld);
        const key = canonicalEdgeKey(p1, p2);

        if (!globalEdgeMap.has(key)) globalEdgeMap.set(key, []);
        globalEdgeMap.get(key).push({
            mesh,
            clusterIndex,
            edgeIndex
        });
    }

    meshLines.set(clusterIndex, newLines);
}


// ------------------------------------------------------------
// Face painting
// ------------------------------------------------------------

function paintCluster(mesh, cluster, color, opacity, recordHistory = true) {
    if (edgeMode) return;

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

    // per-cluster material behavior
    if (opacity === 1) {
        mesh.material.transparent = false;
        mesh.material.depthWrite = true;
    } else {
        mesh.material.transparent = true;
        mesh.material.depthWrite = false;
    }

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
// Edge painting (cluster-level)
// ------------------------------------------------------------

function paintEdgeStyle(mesh, cluster, style) {
    const clusterIndex = mesh.userData.clusterIndex;
    if (clusterIndex == null) return;

    // Update ONLY this cluster's default style
    const meshStyles = edgeStyles.get(mesh);
    meshStyles.set(clusterIndex, {
        color: style.color.clone(),
        width: style.width,
        dashed: style.dashed,
        dashScale: style.dashScale
    });

    // Clear overrides for THIS cluster only
    const meshOverrides = edgeOverrides.get(mesh);
    if (meshOverrides) {
        meshOverrides.delete(clusterIndex);
    }

    // Rebuild this cluster's persistent lines
    updatePersistentEdgeLinesForCluster(mesh, cluster, style);

    // Now update ONLY the boundary edges of this face
    const edgeAttr = getBoundaryEdges(mesh.geometry, cluster);
    const arr = edgeAttr.array;

    for (let i = 0; i < arr.length; i += 6) {
        const edgeIndex = i / 6;

        // Compute world-space endpoints
        const p1World = new THREE.Vector3(arr[i + 0], arr[i + 1], arr[i + 2]).applyMatrix4(mesh.matrixWorld);
        const p2World = new THREE.Vector3(arr[i + 3], arr[i + 4], arr[i + 5]).applyMatrix4(mesh.matrixWorld);

        const key = canonicalEdgeKey(p1World, p2World);
        const twins = globalEdgeMap.get(key) || [];

        // Apply SINGLE-EDGE override to each twin
        for (const twin of twins) {
            // setSingleEdgeStyle(
            //     twin.mesh,
            //     twin.clusterIndex,
            //     twin.edgeIndex,
            //     style
            // );
            if (twin.mesh === mesh && twin.clusterIndex === clusterIndex && twin.edgeIndex === edgeIndex) {
                continue;
            }

            setSingleEdgeStyle(twin.mesh, twin.clusterIndex, twin.edgeIndex, {
                color: style.color.clone(),
                width: 0,            // HIDE the twin
                dashed: false,
                dashScale: style.dashScale,
            });

            const twinCluster = twin.mesh.userData.cluster;
            const twinClusterStyle = edgeStyles.get(twin.mesh).get(twin.clusterIndex);

            // Rebuild only the twin cluster's lines
            updatePersistentEdgeLinesForCluster(
                twin.mesh,
                twinCluster,
                twinClusterStyle
            );
        }
    }
}

function paintWholeMesh(parent, color, opacity, edgeStyle) {
    const clusters = parentToClusters.get(parent);
    clusters.forEach(cm => {
        paintCluster(cm, cm.userData.cluster, color, opacity);
        paintEdgeStyle(cm, cm.userData.cluster, edgeStyle);
    });
}


// ------------------------------------------------------------
// Selection highlight (single edge)
// ------------------------------------------------------------

let singleEdgeHighlight = null;

function highlightSingleEdge(mesh, cluster, edgeIndex) {
    if (singleEdgeHighlight) {
        scene.remove(singleEdgeHighlight);
        singleEdgeHighlight.geometry.dispose();
        singleEdgeHighlight.material.dispose();
        singleEdgeHighlight = null;
    }

    const edgeAttr = getBoundaryEdges(mesh.geometry, cluster);
    const arr = edgeAttr.array;

    const i = edgeIndex * 6;

    const p1Local = new THREE.Vector3(arr[i + 0], arr[i + 1], arr[i + 2]);
    const p2Local = new THREE.Vector3(arr[i + 3], arr[i + 4], arr[i + 5]);

    const p1World = p1Local.clone().applyMatrix4(mesh.matrixWorld);
    const p2World = p2Local.clone().applyMatrix4(mesh.matrixWorld);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([
        p1World.x, p1World.y, p1World.z,
        p2World.x, p2World.y, p2World.z
    ], 3));

    const mat = new THREE.LineBasicMaterial({
        color: 0xff0000,
        linewidth: 5
    });

    singleEdgeHighlight = new THREE.LineSegments(geo, mat);

    singleEdgeHighlight.material.depthTest = false;
    singleEdgeHighlight.material.depthWrite = false;
    singleEdgeHighlight.renderOrder = 999;

    scene.add(singleEdgeHighlight);

    currentSelectedEdge = {
        mesh,
        cluster,
        edgeIndex,
        p1: p1World,
        p2: p2World
    };
}

function applyUIEdgeStyleToSingleEdge() {
    if (!currentSelectedEdge) return;

    const { mesh, cluster, edgeIndex, p1, p2 } = currentSelectedEdge;

    const clusterIndex = mesh.userData.clusterIndex;

    const style = {
        color: new THREE.Color(edgeColorInput.value),
        width: parseFloat(edgeWidthInput.value),
        dashed: edgeDashedInput.checked,
        dashScale: parseFloat(edgeDashScaleInput.value)
    };

    const key = canonicalEdgeKey(p1, p2);
    const twins = globalEdgeMap.get(key) || [];

    for (const twin of twins) {
        const twinMesh = twin.mesh;
        const twinClusterIndex = twin.clusterIndex;
        const twinEdgeIndex = twin.edgeIndex;
        
        if (twin.mesh === mesh && twin.clusterIndex === clusterIndex && twin.edgeIndex === edgeIndex) {
            continue;
        }

        // setSingleEdgeStyle(twinMesh, twinClusterIndex, twinEdgeIndex, style);
        setSingleEdgeStyle(twin.mesh, twin.clusterIndex, twin.edgeIndex, {
            color: style.color.clone(),
            width: 0,            // HIDE the twin
            dashed: false,
            dashScale: style.dashScale,
        });

        setSingleEdgeStyle(mesh, clusterIndex, edgeIndex, style);

        const clusterStyle = edgeStyles.get(mesh).get(clusterIndex);
        updatePersistentEdgeLinesForCluster(mesh, cluster, clusterStyle);

        const twinClusterStyle = edgeStyles.get(twinMesh).get(twinClusterIndex);
        const twinCluster = twinMesh.userData.cluster;

        updatePersistentEdgeLinesForCluster(twinMesh, twinCluster, twinClusterStyle);
    }

    // Re-highlight the originally selected edge
    highlightSingleEdge(mesh, cluster, edgeIndex);
}

// ------------------------------------------------------------
// Geometry helpers
// ------------------------------------------------------------

function closestPointOnSegment(p, a, b) {
    const ab = new THREE.Vector3().subVectors(b, a);
    const t = new THREE.Vector3().subVectors(p, a).dot(ab) / ab.lengthSq();
    const clamped = Math.max(0, Math.min(1, t));
    return new THREE.Vector3().copy(a).addScaledVector(ab, clamped);
}

// ------------------------------------------------------------
// Highlight face / cluster selection
// ------------------------------------------------------------

function highlightFace(hit) {
    if (!edgeMode) {
        deselectEdge();
    }

    const color = new THREE.Color(colorInput.value);
    const opacity = parseFloat(opacityInput.value);

    const style = {
        color: new THREE.Color(edgeColorInput.value),
        width: parseFloat(edgeWidthInput.value),
        dashed: edgeDashedInput.checked,
        dashScale: parseFloat(edgeDashScaleInput.value)
    };

    const clusterMesh = hit.object;
    let cluster = clusterMesh.userData.cluster;
    if (!cluster) return;

    deselectAllFaces();

    if (meshMode) {
        selectWholeMesh(hit.object);
        if (!pickMode) {
            const parent = clusterMesh.userData.parentMesh;
            paintWholeMesh(parent, color, opacity, style)
        }
        else {
            loadFacePropertiesFromCluster(clusterMesh, cluster);
            loadEdgeStyleIntoUI(clusterMesh, cluster);
        }
        return;
    }

    currentSelectedMesh = clusterMesh;
    currentSelectedCluster = cluster;

    if (edgeMode) {
        let mesh = clusterMesh;
        const clickPoint = hit.point.clone();

        const edgeAttr = getBoundaryEdges(mesh.geometry, cluster);
        const arr = edgeAttr.array;

        let bestIndex = -1;
        let bestDist = Infinity;

        for (let i = 0; i < arr.length; i += 6) {
            const edgeIndex = i / 6;

            const p1 = new THREE.Vector3(arr[i + 0], arr[i + 1], arr[i + 2]).applyMatrix4(mesh.matrixWorld);
            const p2 = new THREE.Vector3(arr[i + 3], arr[i + 4], arr[i + 5]).applyMatrix4(mesh.matrixWorld);

            const cp = closestPointOnSegment(clickPoint, p1, p2);
            const dist = cp.distanceTo(clickPoint);

            if (dist < bestDist) {
                bestDist = dist;
                bestIndex = edgeIndex;
            }
        }

        if (bestIndex !== -1) {
            // --- NEW: Correct selection if hidden edge was picked ---
            const clusterIndex = mesh.userData.clusterIndex;
            const meshOverrides = edgeOverrides.get(mesh);
            const clusterOverrides = meshOverrides ? meshOverrides.get(clusterIndex) : null;

            // Get style of the selected edge
            const selectedStyle =
                clusterOverrides && clusterOverrides.get(bestIndex)
                    ? clusterOverrides.get(bestIndex)
                    : edgeStyles.get(mesh).get(clusterIndex);

            // If selected edge is hidden, switch to visible twin
            if (selectedStyle.width === 0) {

                const edgeAttr = getBoundaryEdges(mesh.geometry, cluster);
                const arr = edgeAttr.array;

                const i = bestIndex * 6;
                const p1World = new THREE.Vector3(arr[i], arr[i+1], arr[i+2]).applyMatrix4(mesh.matrixWorld);
                const p2World = new THREE.Vector3(arr[i+3], arr[i+4], arr[i+5]).applyMatrix4(mesh.matrixWorld);

                const key = canonicalEdgeKey(p1World, p2World);
                const twins = globalEdgeMap.get(key) || [];

                for (const twin of twins) {
                    const twinOverrides = edgeOverrides.get(twin.mesh);
                    const twinClusterOverrides = twinOverrides ? twinOverrides.get(twin.clusterIndex) : null;

                    const twinStyle =
                        twinClusterOverrides && twinClusterOverrides.get(twin.edgeIndex)
                            ? twinClusterOverrides.get(twin.edgeIndex)
                            : edgeStyles.get(twin.mesh).get(twin.clusterIndex);

                    if (twinStyle.width > 0) {
                        // Switch selection to visible twin
                        mesh = twin.mesh;
                        cluster = twin.mesh.userData.cluster;
                        bestIndex = twin.edgeIndex;
                        break;
                    }
                }
            }
            highlightSingleEdge(mesh, cluster, bestIndex);

            if (pickMode) {
                loadEdgeStyleIntoUI(mesh, cluster, bestIndex);
            } else {
                applyUIEdgeStyleToSingleEdge();
            }
        }
        return;
    }

    if (pickMode) {
        loadFacePropertiesFromCluster(clusterMesh, cluster);
        loadEdgeStyleIntoUI(clusterMesh, cluster);
    }

    if (!pickMode) {
        paintCluster(clusterMesh, cluster, color, opacity);
        paintEdgeStyle(clusterMesh, cluster, style);
    }

    const geometry = clusterMesh.geometry;

    if (boundaryEdges) {
        scene.remove(boundaryEdges);
        boundaryEdges.geometry.dispose();
        boundaryEdges.material.dispose();
        boundaryEdges = null;
    }

    const edgeAttr = getBoundaryEdges(geometry, cluster);

    if (edgeAttr.count > 0) {
        // highlightEdges(clusterMesh, edgeAttr)
        const boundaryGeo = new THREE.BufferGeometry();
        boundaryGeo.setAttribute("position", edgeAttr);

        const boundaryMat = new THREE.LineBasicMaterial({
            color: 0xff0000,
            linewidth: 1
        });

        boundaryEdges = new THREE.LineSegments(boundaryGeo, boundaryMat);

        boundaryEdges.applyMatrix4(clusterMesh.matrixWorld);
        boundaryEdges.material.depthTest = false;
        boundaryEdges.material.depthWrite = false;
        boundaryEdges.renderOrder = 999;

        boundaryEdges.layers.set(HIGHLIGHT_LAYER);
        scene.add(boundaryEdges);
        boundaryEdges.raycast = () => {};
    }
}

let meshHighlights = [];

function selectWholeMesh(clusterMesh) {
    deselectAllFaces();

    const parent = clusterMesh.userData.parentMesh;
    if (!parent) return;

    const clusters = parentToClusters.get(parent);
    if (!clusters) return;

    meshHighlights = [];

    // Highlight all boundary edges for all clusters
    clusters.forEach(cm => {
        const cluster = cm.userData.cluster;

        const edgeAttr = getBoundaryEdges(cm.geometry, cluster);
        if (edgeAttr.count === 0) return;

        const boundaryGeo = new THREE.BufferGeometry();
        boundaryGeo.setAttribute("position", edgeAttr);

        const boundaryMat = new THREE.LineBasicMaterial({
            color: 0xff0000,
            linewidth: 1
        });

        const boundary = new THREE.LineSegments(boundaryGeo, boundaryMat);
        boundary.applyMatrix4(cm.matrixWorld);
        boundary.material.depthTest = false;
        boundary.material.depthWrite = false;
        boundary.renderOrder = 999;

        scene.add(boundary);

        // highlightEdges(clusterMesh, edgeAttr)
        meshHighlights.push(boundary);
    });

    // Store selection state
    currentSelectedMesh = parent;
    currentSelectedCluster = null;
    currentSelectedEdge = null;
}

function highlightEdges(clusterMesh, edgeAttr){
    const boundaryGeo = new THREE.BufferGeometry();
    boundaryGeo.setAttribute("position", edgeAttr);

    const boundaryMat = new THREE.LineBasicMaterial({
        color: 0xff0000,
        linewidth: 1
    });

    boundaryEdges = new THREE.LineSegments(boundaryGeo, boundaryMat);

    if (clusterMesh) boundaryEdges.applyMatrix4(clusterMesh.matrixWorld);
    boundaryEdges.material.depthTest = false;
    boundaryEdges.material.depthWrite = false;
    boundaryEdges.renderOrder = 999;

    boundaryEdges.layers.set(HIGHLIGHT_LAYER);
    scene.add(boundaryEdges);
    boundaryEdges.raycast = () => {};
}

// ------------------------------------------------------------
// Deselection
// ------------------------------------------------------------

function deselectAllFaces() {
    
    if (boundaryEdges) {
        scene.remove(boundaryEdges);
        boundaryEdges.geometry.dispose();
        boundaryEdges.material.dispose();
        boundaryEdges = null;
    }

    if (meshHighlights.length > 0) {
        meshHighlights.forEach(h => {
            scene.remove(h);
            h.geometry.dispose();
            h.material.dispose();
        });
        meshHighlights = [];
    }

    currentSelectedMesh = null;
    currentSelectedCluster = null;
    currentSelectedEdge = null;


    // NEW: also clear any selected edge
    deselectEdge();
}

function deselectEdge() {
    if (singleEdgeHighlight) {
        scene.remove(singleEdgeHighlight);
        singleEdgeHighlight.geometry.dispose();
        singleEdgeHighlight.material.dispose();
        singleEdgeHighlight = null;
    }

    currentSelectedMesh = null;
    currentSelectedCluster = null;
    currentSelectedEdge = null;
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

        // restore material behavior
        if (op.newOpacity === 1) {
            op.mesh.material.transparent = false;
            op.mesh.material.depthWrite = true;
        } else {
            op.mesh.material.transparent = true;
            op.mesh.material.depthWrite = false;
        }
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

function loadEdgeStyleIntoUI(mesh, cluster, edgeIndex) {
    const clusterIndex = mesh.userData.clusterIndex;
    if (clusterIndex == null) return;

    const meshOverrides = edgeOverrides.get(mesh);
    const clusterOverrides = meshOverrides ? meshOverrides.get(clusterIndex) : null;

    // If this edge has an override, use it
    const override = clusterOverrides ? clusterOverrides.get(edgeIndex) : null;

    // Otherwise use the cluster-level style
    const clusterStyle = edgeStyles.get(mesh).get(clusterIndex);
    const s = override || clusterStyle;

    edgeColorInput.value = "#" + s.color.getHexString();
    edgeWidthInput.value = s.width;
    edgeDashedInput.checked = s.dashed;
    edgeDashScaleInput.value = s.dashScale;
}

// ------------------------------------------------------------
// UI event wiring
// ------------------------------------------------------------

function applyUIFacePaint() {

    const color = new THREE.Color(colorInput.value);
    const opacity = parseFloat(opacityInput.value);

    if (meshMode) {
        const clusters = parentToClusters.get(currentSelectedMesh);
        if (!clusters) return;
        clusters.forEach(cm => {
            paintCluster(cm, cm.userData.cluster, color, opacity);
            // paintEdgeStyle(cm, cm.userData.cluster, style);
        });
    } 
    else {
        if (!currentSelectedMesh || !currentSelectedCluster) return;
        paintCluster(currentSelectedMesh, currentSelectedCluster, color, opacity);
    }
}

colorInput.addEventListener("input", applyUIFacePaint);
opacityInput.addEventListener("input", applyUIFacePaint);

function applyUIEdgeStyle() {
    const style = {
        color: new THREE.Color(edgeColorInput.value),
        width: parseFloat(edgeWidthInput.value),
        dashed: edgeDashedInput.checked,
        dashScale: parseFloat(edgeDashScaleInput.value)
    };
    
    if (meshMode) {
        const clusters = parentToClusters.get(currentSelectedMesh);
        if (!clusters) return;
        clusters.forEach(cm => {
            // paintCluster(cm, cm.userData.cluster, color, opacity);
            paintEdgeStyle(cm, cm.userData.cluster, style);
        });
    } 
    else {
        // If a single edge is selected → only update that edge
        if (currentSelectedEdge) {
            applyUIEdgeStyleToSingleEdge();
            return;
        }

        // If no face is selected → do nothing
        if (!currentSelectedMesh || !currentSelectedCluster) {
            return;
        }

        paintEdgeStyle(currentSelectedMesh, currentSelectedCluster, style);
    }
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
    deselectAllFaces()

    // mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    // mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    const rect = renderer.domElement.getBoundingClientRect();

    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

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

    scene.traverse((obj) => {
        if (obj.isLineSegments2 && obj.material && obj.material.resolution) {
            obj.material.resolution.set(w, h);
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

    deselectAllFaces()

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

window.addEventListener("keydown", (e) => {
    if (e.key === "e") edgeMode = true;
});

window.addEventListener("keyup", (e) => {
    if (e.key === "e") edgeMode = false;
});

const faceModeRadio = document.getElementById("faceModeRadio");
const edgeModeRadio = document.getElementById("edgeModeRadio");
const meshModeRadio = document.getElementById("meshModeRadio");

faceModeRadio.addEventListener("change", () => {
    if (faceModeRadio.checked) {
        edgeMode = false;
        meshMode = false;
        deselectAllFaces();
        deselectEdge();
        opacityInput.disabled = false
        colorInput.disabled = false
    }
});

edgeModeRadio.addEventListener("change", () => {
    if (edgeModeRadio.checked) {
        edgeMode = true;
        meshMode = false;
        deselectAllFaces();
        opacityInput.disabled = true
        colorInput.disabled = true
    }
});

meshModeRadio.addEventListener("change", () => {
    if (meshModeRadio.checked) {
        meshMode = true;
        edgeMode = false;
        deselectAllFaces();
        opacityInput.disabled = false
        colorInput.disabled = false
    }
});

const paintModeRadio = document.getElementById("paintModeRadio");
const pickModeRadio = document.getElementById("pickModeRadio");

paintModeRadio.addEventListener("change", () => {
    if (paintModeRadio.checked) {
        pickMode = false;
    }
});

pickModeRadio.addEventListener("change", () => {
    if (pickModeRadio.checked) {
        pickMode = true;
    }
});


//
function exportSVG() {
    if (!currentModel) return;

    const width  = renderer.domElement.width;
    const height = renderer.domElement.height;

    const svgPaths = [];
    const meshes = [];
    currentModel.traverse(o => { if (o.isMesh) meshes.push(o); });

    const emittedClusterSignatures = new Set();

    // --- Helpers -------------------------------------------------------------

    function signedArea2D(pts) {
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
            const [x1, y1] = pts[i];
            const [x2, y2] = pts[(i + 1) % pts.length];
            a += (x1 * y2 - x2 * y1);
        }
        return 0.5 * a;
    }

    function centroid(pts) {
        let x = 0, y = 0;
        for (const p of pts) { x += p[0]; y += p[1]; }
        return [x / pts.length, y / pts.length];
    }

    function pointInPolygon(point, poly) {
        const [px, py] = point;
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const [xi, yi] = poly[i];
            const [xj, yj] = poly[j];
            const intersect =
                ((yi > py) !== (yj > py)) &&
                (px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    // --- Main ---------------------------------------------------------------

    for (const mesh of meshes) {
        const clusters = mesh.userData.surfaceClusters;
        if (!clusters) continue;

        const geo    = mesh.geometry;
        const index  = geo.index;
        const colors = geo.attributes.color;

        clusters.forEach((cluster, clusterIndex) => {
            if (!cluster || cluster.length === 0) return;

            // --- 1. Face color ------------------------------------------------
            const f0 = cluster[0];
            const i0 = index.getX(f0 * 3 + 0);

            const lr = colors.getX(i0);
            const lg = colors.getY(i0);
            const lb = colors.getZ(i0);
            const a  = colors.getW(i0);

            const srgb = new THREE.Color(lr, lg, lb).convertLinearToSRGB();
            const fillColor   = `rgb(${Math.round(srgb.r * 255)},${Math.round(srgb.g * 255)},${Math.round(srgb.b * 255)})`;
            const fillOpacity = a;

            // --- 2. Stroke style ---------------------------------------------
            const style = edgeStyles.get(mesh)?.get(clusterIndex);
            if (!style) return;

            const strokeColor = style.color.clone().convertLinearToSRGB().getStyle();

            // --- 3. Boundary edges -------------------------------------------
            const edgeAttr = getBoundaryEdges(geo, cluster);
            if (!edgeAttr || edgeAttr.count === 0) return;

            const segments = [];
            for (let i = 0; i < edgeAttr.count; i += 2) {
                const v1 = new THREE.Vector3(
                    edgeAttr.array[i*3+0],
                    edgeAttr.array[i*3+1],
                    edgeAttr.array[i*3+2]
                ).applyMatrix4(mesh.matrixWorld);

                const v2 = new THREE.Vector3(
                    edgeAttr.array[(i+1)*3+0],
                    edgeAttr.array[(i+1)*3+1],
                    edgeAttr.array[(i+1)*3+2]
                ).applyMatrix4(mesh.matrixWorld);

                segments.push([v1, v2]);
            }

            // --- 4. Build ordered loops --------------------------------------
            let loops = buildOrderedLoops(segments);
            if (!loops || loops.length === 0) return;

            // --- 5. Deduplicate loops ----------------------------------------
            const seenLoopSigs = new Set();
            const uniqueLoops  = [];

            for (const loop of loops) {
                const sig = loopSignature(loop);
                if (!seenLoopSigs.has(sig)) {
                    seenLoopSigs.add(sig);
                    uniqueLoops.push(loop);
                }
            }
            loops = uniqueLoops;
            if (loops.length === 0) return;

            // --- 6. Project + classify loops ---------------------------------
            const loopInfos = [];
            const clusterGeomSigParts = [];

            for (const loop of loops) {
                const projected = loop.map(v => {
                    const p = v.clone().project(activeCamera);
                    return [
                        (p.x * 0.5 + 0.5) * width,
                        (1 - (p.y * 0.5 + 0.5)) * height
                    ];
                });

                const area = signedArea2D(projected);

                clusterGeomSigParts.push(
                    projected
                        .map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`)
                        .sort()
                        .join("|")
                );

                loopInfos.push({ projected, area });
            }

            // Determine which loops are holes
            for (const li of loopInfos) {
                const c = centroid(li.projected);
                li.isHole = false;

                for (const other of loopInfos) {
                    if (other === li) continue;
                    if (Math.abs(other.area) < Math.abs(li.area)) continue;
                    if (pointInPolygon(c, other.projected)) {
                        li.isHole = true;
                        break;
                    }
                }
            }

            // --- 7. Build final path with enforced winding --------------------
            let d = "";

            for (const li of loopInfos) {
                let pts = li.projected;

                if (!li.isHole) {
                    // Outer → CCW
                    if (li.area < 0) pts = pts.slice().reverse();
                } else {
                    // Hole → CW
                    if (li.area > 0) pts = pts.slice().reverse();
                }

                d += pts.map((p, i) => {
                    const cmd = (i === 0) ? "M" : "L";
                    return `${cmd} ${p[0]},${p[1]}`;
                }).join(" ") + " Z ";
            }

            // --- 8. Cluster-level dedupe -------------------------------------
            const clusterSig = [
                fillColor,
                fillOpacity.toFixed(3),
                strokeColor,
                style.width.toFixed(3),
                style.dashed ? style.dashScale.toFixed(3) : "solid",
                clusterGeomSigParts.sort().join("||")
            ].join("::");

            if (emittedClusterSignatures.has(clusterSig)) return;
            emittedClusterSignatures.add(clusterSig);

            // --- 9. Emit path -------------------------------------------------
            svgPaths.push(`
                <path d="${d}"
                      fill="${fillColor}"
                      fill-opacity="${fillOpacity}"
                      stroke="${strokeColor}"
                      stroke-width="${style.width}"
                      ${style.dashed ? `stroke-dasharray="${style.dashScale * 70}"` : ""}
                      fill-rule="nonzero"
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

function loopSignature(loop) {
    const pts = loop.map(v => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`);
    pts.sort();
    return pts.join("|");
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
    updateAllPersistentEdges();

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

function updateAllPersistentEdges() {
    scene.traverse(obj => {
        if (obj.isMesh && obj.userData.cluster) {
            const cluster = obj.userData.cluster;
            const clusterIndex = obj.userData.clusterIndex;
            const style = edgeStyles.get(obj).get(clusterIndex);
            updatePersistentEdgeLinesForCluster(obj, cluster, style);
        }
    });
}


// ------------------------------------------------------------
// Main loop
// ------------------------------------------------------------

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, activeCamera);

    // // Uncomment below to enable live high-res render

    // if (!currentModel) return;

    // // Compute target resolution
    // const w = renderer.domElement.width * SNAPSHOT_SCALE;
    // const h = renderer.domElement.height * SNAPSHOT_SCALE;

    // snapshotRenderer.setSize(w, h, false);

    // // Render scene using the active camera
    // snapshotRenderer.render(scene, activeCamera);

    // // Convert to PNG
    // const dataURL = snapshotRenderer.domElement.toDataURL("image/png");

    // // Display in preview box
    // const img = document.getElementById("renderOutput");
    // img.src = dataURL;

    // // Store for saving
    // window.lastRenderDataURL = dataURL;
}
animate();
