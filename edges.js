import * as THREE from "https://esm.sh/three@0.164.0";
import { LineSegmentsGeometry } from "https://esm.sh/three@0.164.0/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "https://esm.sh/three@0.164.0/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "https://esm.sh/three@0.164.0/examples/jsm/lines/LineSegments2.js";

import {currentModel, scene, selectScope, undoStack, redoStack} from "./scene.js";
import {currentSelectedMesh, currentSelectedCluster,parentToClusters} from "./faces.js";

export const edgeStyles = new WeakMap();          // mesh → Map(clusterIndex → style)
export const persistentEdgeLines = new WeakMap(); // mesh → Map(clusterIndex → LineSegments2)
export const edgeOverrides = new WeakMap();       // mesh → Map(clusterIndex → Map(edgeIndex → style))
export const globalEdgeMap = new Map();
let edgeDepthBias = 0.0001;

export let editEdges = true 

let currentSelectedEdge = null; // { mesh, cluster, edgeIndex, p1, p2 }

export let boundaryEdges = null;
export function setBoundaryEdges(edges){
    boundaryEdges = edges
}
export function clearBoundaryEdges(){
    boundaryEdges = null
}

export const HIGHLIGHT_LAYER = 2; 

export const edgeColorInput = document.getElementById("edgeColor");
export const edgeWidthInput = document.getElementById("edgeWidth");
export const edgeDashScaleInput = document.getElementById("edgeDashScale");
export const edgeDashedInput = document.getElementById("edgeDashed");

edgeColorInput.addEventListener("input", applyEdgeStyle);
edgeWidthInput.addEventListener("input", applyEdgeStyle);
edgeDashScaleInput.addEventListener("input", applyEdgeStyle);
edgeDashedInput.addEventListener("change", applyEdgeStyle);

const edgeModeCB = document.getElementById("edgeModeRadio");

edgeModeCB.addEventListener("change", () => {
    // if (!faceModeCB.checked && !edgeModeCB.checked) edgeModeCB.checked = true
    if (edgeModeCB.checked) {
        editEdges = true
        edgeColorInput.disabled = false
        edgeWidthInput.disabled = false
        edgeDashScaleInput.disabled = false
        edgeDashedInput.disabled = false
    } else {
        editEdges = false
        edgeColorInput.disabled = true
        edgeWidthInput.disabled = true
        edgeDashScaleInput.disabled = true
        edgeDashedInput.disabled = true
    }
});

export function updatePersistentEdgeLinesForCluster(mesh, cluster, clusterStyle) {
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

    // console.log("updatePersistentEdgeLinesForCluster")
}

export function getBoundaryEdges(geometry, cluster) {
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

export function paintClusterEdges(mesh, cluster, style, recordHistory=true) {
    if (!editEdges) return

    // Get the index of the relevant cluster
    const clusterIndex = mesh.userData.clusterIndex;
    if (clusterIndex == null) return;

    // Update this cluster's edge style
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
            if (twin.mesh === mesh && twin.clusterIndex === clusterIndex && twin.edgeIndex === edgeIndex) {
                continue;
            }
            if (style.dashed) {
                // Hide twin when dashed
                setEdgeStyle(twin.mesh, twin.clusterIndex, twin.edgeIndex, {
                    color: style.color.clone(),
                    width: 0,
                    dashed: false,
                    dashScale: style.dashScale
                });
            } else {
                // Match twin when not dashed
                setEdgeStyle(twin.mesh, twin.clusterIndex, twin.edgeIndex, {
                    color: style.color.clone(),
                    width: style.width,
                    dashed: false,
                    dashScale: style.dashScale
                });
            }

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

    if (recordHistory) {
        undoStack.push({
            type: "edgeStyle",
            mesh,
            cluster,
            style
        });

        redoStack.length = 0;
    }
    console.log("paintClusterEdges")
}

export let edgeHighlight = null;

export function getEdgeStyle(
    color=new THREE.Color(edgeColorInput.value), 
    width=parseFloat(edgeWidthInput.value), 
    dashed=edgeDashedInput.checked, 
    dashScale=parseFloat(edgeDashScaleInput.value)){
        
    const style = {
        color: color,
        width: width,
        dashed: dashed,
        dashScale: dashScale
    };

    return style
}

export function applyEdgeStyle() {
    if (!editEdges) return

    const style = getEdgeStyle()
    
    if (selectScope === "3D") {
        const clusters = parentToClusters.get(currentSelectedMesh);
        if (!clusters) return;
        clusters.forEach(cm => {
            paintClusterEdges(cm, cm.userData.cluster, style);
        });
    } 
    else if (selectScope === "2D") {
        // If no face is selected → do nothing
        if (!currentSelectedMesh || !currentSelectedCluster) {
            return;
        }
        paintClusterEdges(currentSelectedMesh, currentSelectedCluster, style);
    }
    else {
        if (currentSelectedEdge) {
            paintEdgeLines();
            return;
        }
    }
    // console.log("applyEdgeStyle")
}

function paintEdgeLines() {
    if (!currentSelectedEdge) return;

    const { mesh, cluster, edgeIndices } = currentSelectedEdge;
    const clusterIndex = mesh.userData.clusterIndex;

    const style = getEdgeStyle()

    const edgeAttr = getBoundaryEdges(mesh.geometry, cluster);
    const arr = edgeAttr.array;

    for (const edgeIndex of edgeIndices) {
        const i = edgeIndex * 6;

        const p1World = new THREE.Vector3(arr[i], arr[i+1], arr[i+2]).applyMatrix4(mesh.matrixWorld);
        const p2World = new THREE.Vector3(arr[i+3], arr[i+4], arr[i+5]).applyMatrix4(mesh.matrixWorld);

        const key = canonicalEdgeKey(p1World, p2World);
        const twins = globalEdgeMap.get(key) || [];

        for (const twin of twins) {
            const twinMesh = twin.mesh;
            const twinClusterIndex = twin.clusterIndex;
            const twinEdgeIndex = twin.edgeIndex;

            const isSelected =
                twinMesh === mesh &&
                twinClusterIndex === clusterIndex &&
                twinEdgeIndex === edgeIndex;

            if (isSelected) {
                // Selected edges get full style
                setEdgeStyle(mesh, clusterIndex, edgeIndex, style);
            } else {
                // Twins follow dashed/hide rule
                if (style.dashed) {
                    setEdgeStyle(twinMesh, twinClusterIndex, twinEdgeIndex, {
                        color: style.color.clone(),
                        width: 0,
                        dashed: false,
                        dashScale: style.dashScale
                    });
                } else {
                    setEdgeStyle(twinMesh, twinClusterIndex, twinEdgeIndex, {
                        color: style.color.clone(),
                        width: style.width,
                        dashed: false,
                        dashScale: style.dashScale
                    });
                }
            }

            // Rebuild twin cluster lines
            const twinClusterStyle = edgeStyles.get(twinMesh).get(twinClusterIndex);
            const twinCluster = twinMesh.userData.cluster;

            updatePersistentEdgeLinesForCluster(twinMesh, twinCluster, twinClusterStyle);
        }
    }

    // Rebuild selected cluster lines
    const clusterStyle = edgeStyles.get(mesh).get(clusterIndex);
    updatePersistentEdgeLinesForCluster(mesh, cluster, clusterStyle);

    // highlightMultipleEdges(mesh, cluster, edgeIndices);

    // console.log("paintEdgeLines")
}

export function buildBoundaryEdgeGraph(mesh, cluster) {
    const edgeAttr = getBoundaryEdges(mesh.geometry, cluster);
    const arr = edgeAttr.array;

    const edges = [];
    const vertToEdges = new Map();

    function vKey(p) {
        return `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`;
    }

    for (let i = 0; i < arr.length; i += 6) {
        const edgeIndex = i / 6;

        const p1 = new THREE.Vector3(arr[i], arr[i+1], arr[i+2]).applyMatrix4(mesh.matrixWorld);
        const p2 = new THREE.Vector3(arr[i+3], arr[i+4], arr[i+5]).applyMatrix4(mesh.matrixWorld);

        const dir = new THREE.Vector3().subVectors(p2, p1).normalize();

        const length = p1.distanceTo(p2);

        const e = {
            index: edgeIndex,
            p1, p2,
            dir,
            verts: [vKey(p1), vKey(p2)],
            length
        };

        edges.push(e);

        for (const vk of e.verts) {
            if (!vertToEdges.has(vk)) vertToEdges.set(vk, []);
            vertToEdges.get(vk).push(e);
        }
    }

    return { edges, vertToEdges };
}
export function collectRelatedEdges(mesh, cluster, startEdgeIndex, maxAngleDeg = 20) {
    const { edges, vertToEdges } = buildBoundaryEdgeGraph(mesh, cluster);

    const startEdge = edges.find(e => e.index === startEdgeIndex);
    if (!startEdge) return [startEdgeIndex];

    const maxAngle = THREE.MathUtils.degToRad(maxAngleDeg);

    const visited = new Set();
    const queue = [startEdge];

    visited.add(startEdge.index);

    const maxPct = 0.25; // 25% length tolerance (tunable)
    // const maxCurvature = 10; // tunable curvature threshold

    while (queue.length > 0) {
        const cur = queue.shift();

        for (const vk of cur.verts) {
            const neighbors = vertToEdges.get(vk) || [];

            for (const nb of neighbors) {
                if (visited.has(nb.index)) continue;

                // --- ANGLE RULE ---
                const angle1 = cur.dir.angleTo(nb.dir);
                const angle2 = cur.dir.angleTo(nb.dir.clone().multiplyScalar(-1));
                const angle = Math.min(angle1, angle2);
                if (angle > maxAngle) continue;

                // --- LENGTH RULE ---
                const Lprev = cur.length;
                const Lnext = nb.length;
                const pctDiff = Math.abs(Lnext - Lprev) / Lprev;

                if (pctDiff > maxPct) continue;

                // const curvature = angle / cur.length;
                // if (curvature > maxCurvature) continue;

                // Passed all rules → include
                visited.add(nb.index);
                queue.push(nb);
            }
        }
    }

    return Array.from(visited);
}

function canonicalEdgeKey(p1, p2) {
    const a = `${p1.x.toFixed(6)},${p1.y.toFixed(6)},${p1.z.toFixed(6)}`;
    const b = `${p2.x.toFixed(6)},${p2.y.toFixed(6)},${p2.z.toFixed(6)}`;
    return (a < b) ? `${a}|${b}` : `${b}|${a}`;
}

document.getElementById("edgeBias").addEventListener("input", (e) => {
    edgeDepthBias = parseFloat(e.target.value);
    scene.traverse(obj => {
        if (obj.isMesh && obj.userData.cluster) {
            const cluster = obj.userData.cluster;
            const clusterIndex = obj.userData.clusterIndex;
            const style = edgeStyles.get(obj).get(clusterIndex);
            updatePersistentEdgeLinesForCluster(obj, cluster, style);
        }
    });

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

function setEdgeStyle(mesh, clusterIndex, edgeIndex, style) {
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

    // console.log("setEdgeStyle")
}

export function highlightMultipleEdges(mesh, cluster, edgeIndices) {
    // Clear previous highlight
    if (edgeHighlight) {
        scene.remove(edgeHighlight);
        edgeHighlight.geometry.dispose();
        edgeHighlight.material.dispose();
        edgeHighlight = null;
    }

    const edgeAttr = getBoundaryEdges(mesh.geometry, cluster);
    const arr = edgeAttr.array;

    const positions = [];

    for (const ei of edgeIndices) {
        const i = ei * 6;

        const p1 = new THREE.Vector3(arr[i], arr[i+1], arr[i+2]).applyMatrix4(mesh.matrixWorld);
        const p2 = new THREE.Vector3(arr[i+3], arr[i+4], arr[i+5]).applyMatrix4(mesh.matrixWorld);

        positions.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({
        color: 0xff0000,
        linewidth: 5,
        depthTest: false,
        depthWrite: false
    });

    edgeHighlight = new THREE.LineSegments(geo, mat);
    edgeHighlight.renderOrder = 999;

    scene.add(edgeHighlight);

    currentSelectedEdge = {
        mesh,
        cluster,
        edgeIndices
    };
    // console.log("highlightMultipleEdges")
}

export function deselectEdge() {
    if (edgeHighlight) {
        scene.remove(edgeHighlight);
        edgeHighlight.geometry.dispose();
        edgeHighlight.material.dispose();
    }

    currentSelectedEdge = null;
}

export function loadEdgeStyleIntoUI(mesh, cluster, edgeIndex) {
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

export function closestPointOnSegment(p, a, b) {
    const ab = new THREE.Vector3().subVectors(b, a);
    const t = new THREE.Vector3().subVectors(p, a).dot(ab) / ab.lengthSq();
    const clamped = Math.max(0, Math.min(1, t));
    return new THREE.Vector3().copy(a).addScaledVector(ab, clamped);
}