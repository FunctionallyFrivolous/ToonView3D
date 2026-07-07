
import * as THREE from "https://esm.sh/three@0.164.0";
import { OrbitControls } from "https://esm.sh/three@0.164.0/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "https://esm.sh/three@0.164.0/examples/jsm/loaders/OBJLoader.js";
import { mergeVertices } from "https://esm.sh/three@0.164.0/examples/jsm/utils/BufferGeometryUtils.js";
import {
    edgeStyles, edgeColorInput, edgeWidthInput, edgeDashedInput, edgeDashScaleInput,
    editEdges,
    persistentEdgeLines,
    edgeOverrides,
    updatePersistentEdgeLinesForCluster,
    deselectEdge,
    highlightSelectedEdges, selectedEdges
} from "./edges.js";
import {
    parentToClusters,
    deselectAllFaces,
    opacityInput, colorInput,
    faceModeCB,
    editFaces,
    highlightFace,
    paintClusterFace
} from "./faces.js";
import { exportSVG } from "./svgExport.js";

export let currentModel = null;

let pointerDown = false;
let moved = false;
let downX = 0;
let downY = 0;

// ------------------------------------------------------------
// Scene setup
// ------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

export const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
);

const aspect = window.innerWidth / window.innerHeight;
const orthoSize = 4;

const orthoCamera = new THREE.OrthographicCamera(
    -orthoSize * aspect, orthoSize * aspect,
    orthoSize, -orthoSize,
    0.1, 1000
);

export let activeCamera = orthoCamera;
let tempCamPos = null
let tempCamQuat = null

// const renderer = new THREE.WebGLRenderer({ antialias: true });
export const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,        // <‑‑ critical
    // preserveDrawingBuffer: true  // <‑‑ required for toDataURL()
});

const controls = new OrbitControls(activeCamera, renderer.domElement);

const dir = new THREE.DirectionalLight(0xffffff, 0.8);


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

const backgroundColor = document.getElementById("bgColor");

const colorPanel = document.getElementById("colorPanel");



// ------------------------------------------------------------
// OBJ loading
// ------------------------------------------------------------

const loader = new OBJLoader();

export function loadScene(){
    scene.background = null;

    // Setup Camera(s)
    camera.position.set(3, 3, 3);

    orthoCamera.position.copy(camera.position);
    orthoCamera.lookAt(0, 0, 0);

    renderer.setClearColor(0x000000, 0);   // transparent black
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.getContext().getExtension("EXT_frag_depth");

    controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 2));

    dir.position.set(5, 5, 5);
    scene.add(dir);

    backgroundColor.addEventListener("input", () => {
        scene.background = new THREE.Color(backgroundColor.value)
    });

    loader.load("model.obj", (obj) => {
        initializeModel(obj);
    });

    tempCamPos = activeCamera.position.toArray()
    tempCamQuat = activeCamera.quaternion.toArray()

}

// ------------------------------------------------------------
// OBJ File Loading
// ------------------------------------------------------------

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

if (colorPanel) {
    colorPanel.addEventListener("pointerdown", (e) => e.stopPropagation());
    colorPanel.addEventListener("pointerup", (e) => e.stopPropagation());
}

export let selectScope = "2D"

const select3DRadio = document.getElementById("select3DRadio");
const select2DRadio = document.getElementById("select2DRadio");
const select1DRadio = document.getElementById("select1DRadio");

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

export function buildClusterMesh(parentMesh, cluster) {
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

function updateAllLineResolutions() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    scene.traverse((obj) => {
        if (obj.isLineSegments2 && obj.material && obj.material.resolution) {
            obj.material.resolution.set(w, h);
        }
    });
}

export function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, activeCamera);

    // renderScene()
}

// ------------------------------------------------------------
// High‑Resolution Snapshot Renderer
// ------------------------------------------------------------

// const snapshotRenderer = new THREE.WebGLRenderer({ antialias: true });
const snapshotRenderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,        // <‑‑ critical
    preserveDrawingBuffer: true  // <‑‑ required for toDataURL()
});
snapshotRenderer.setPixelRatio(1);

// How many times bigger than the live view?
const SNAPSHOT_SCALE = 2;

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

export const undoStack = [];
export const redoStack = [];

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
        applyEdgeStyleToSelectedEdges()
    }

    redoStack.push(op);
}

function redo() {
    if (redoStack.length === 0) return;

    const op = redoStack.pop();

    if (op.type === "facePaint") {
        paintClusterFace(op.mesh, op.cluster, op.newColor, op.newOpacity, false);
    }

    if (op.type === "edgeStyle") {
        applyEdgeStyleToSelectedEdges()
    }

    undoStack.push(op);
}

function renderScene(){
    const transBackground = document.getElementById("transBG");
    if (transBackground.checked) scene.background = null;

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

    scene.background = new THREE.Color(backgroundColor.value)
    // console.log("hi")

    tempCamPos = activeCamera.position.toArray()
    tempCamQuat = activeCamera.quaternion.toArray()
}


// DOM

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
    // deselectEdge()
    // selectedEdges.clear();
    highlightSelectedEdges();


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
        deselectEdge();
    }

});

window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "z") undo();
    if (e.ctrlKey && e.key === "y") redo();
    if (e.key === "Escape") {
        deselectAllFaces();
        deselectEdge()
    };
});

// window.addEventListener("keyup", (e) => {
//     // if (e.key === "p") pickMode = false;
// });

// Render button
document.getElementById("renderButton").addEventListener("click", () => {
    if (!currentModel) return;

    deselectAllFaces()
    deselectEdge()

    renderScene()
});

document.getElementById("revertView").addEventListener("click", () => {
    controls.enableDamping = false;
    controls.update(); 

    activeCamera.position.fromArray(tempCamPos);
    activeCamera.quaternion.fromArray(tempCamQuat);

    controls.enableDamping = true;
});

// Save button
document.getElementById("saveRenderButton").addEventListener("click", () => {
    if (!window.lastRenderDataURL) return;

    const a = document.createElement("a");
    a.href = window.lastRenderDataURL;
    a.download = "render.png";
    a.click();
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

    updateAllLineResolutions();
});

select3DRadio.addEventListener("change", () => {
    if (select3DRadio.checked) {
        selectScope = "3D";
        deselectAllFaces();
        deselectEdge();

        opacityInput.disabled = editFaces ? false : true
        colorInput.disabled = editFaces ? false : true

        edgeColorInput.disabled = editEdges ? false : true
        edgeWidthInput.disabled = editEdges ? false : true
        edgeDashScaleInput.disabled = editEdges ? false : true
        edgeDashedInput.disabled = editEdges ? false : true

        faceModeCB.disabled = false
    }
});
select2DRadio.addEventListener("change", () => {
    if (select2DRadio.checked) {
        selectScope = "2D";
        // deselectAllFaces();
        // deselectEdge();

        opacityInput.disabled = editFaces ? false : true
        colorInput.disabled = editFaces ? false : true

        edgeColorInput.disabled = editEdges ? false : true
        edgeWidthInput.disabled = editEdges ? false : true
        edgeDashScaleInput.disabled = editEdges ? false : true
        edgeDashedInput.disabled = editEdges ? false : true

        faceModeCB.disabled = false
    }
});
select1DRadio.addEventListener("change", () => {
    if (select1DRadio.checked) {
        selectScope = "1D";
        deselectAllFaces();

        opacityInput.disabled = true
        colorInput.disabled = true

        edgeColorInput.disabled = editEdges ? false : true
        edgeWidthInput.disabled = editEdges ? false : true
        edgeDashScaleInput.disabled = editEdges ? false : true
        edgeDashedInput.disabled = editEdges ? false : true

        faceModeCB.disabled = true
    }
});

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

document.getElementById("viewerContainer").appendChild(renderer.domElement);