import * as THREE from "https://esm.sh/three@0.164.0";

import {
    editEdges,
    boundaryEdges, getBoundaryEdges, setBoundaryEdges, clearBoundaryEdges,
    HIGHLIGHT_LAYER,
    closestPointOnSegment, collectRelatedEdges, highlightMultipleEdges,
    applyEdgeStyle,
    edgeOverrides, edgeStyles,
    loadEdgeStyleIntoUI,
    getEdgeStyle, paintClusterEdges, deselectEdge
} from "./edges.js";

import { selectScope, scene, undoStack, redoStack} from "./scene.js";


export const parentToClusters = new WeakMap();

export let currentSelectedMesh = null;

export let currentSelectedCluster = null;

export let editFaces = true

export const colorInput = document.getElementById("faceColor");
export const opacityInput = document.getElementById("faceOpacity");
colorInput.addEventListener("input", applyUIFacePaint);
opacityInput.addEventListener("input", applyUIFacePaint);

let meshHighlights = [];

export const faceModeCB = document.getElementById("faceModeRadio");

faceModeCB.addEventListener("change", () => {
    if (faceModeCB.checked) {
        editFaces = true
        opacityInput.disabled = false
        colorInput.disabled = false
    } else {
        editFaces = false
        opacityInput.disabled = true
        colorInput.disabled = true
    }
});

export function deselectAllFaces() {
    
    if (boundaryEdges) {
        scene.remove(boundaryEdges);
        boundaryEdges.geometry.dispose();
        boundaryEdges.material.dispose();
        clearBoundaryEdges()
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
}

function selectWholeMesh(clusterMesh) {
    deselectAllFaces();
    deselectEdge()

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

        meshHighlights.push(boundary);
    });

    // Store selection state
    currentSelectedMesh = parent;
    currentSelectedCluster = null;
}

export function highlightFace(hit) {
    if (selectScope !== "1D") {
        deselectEdge();
    }

    const color = new THREE.Color(colorInput.value);
    const opacity = parseFloat(opacityInput.value);

    const style = getEdgeStyle()

    const clusterMesh = hit.object;
    let cluster = clusterMesh.userData.cluster;
    if (!cluster) return;

    deselectAllFaces();

    if (selectScope === "3D") {
        selectWholeMesh(hit.object);
        const parent = clusterMesh.userData.parentMesh;
        paintWholeMesh(parent, color, opacity, style)

        loadFacePropertiesFromCluster(clusterMesh, cluster);
        loadEdgeStyleIntoUI(clusterMesh, cluster);
        return;
    }

    currentSelectedMesh = clusterMesh;
    currentSelectedCluster = cluster;

    if (selectScope === "1D") {
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
            const related = collectRelatedEdges(mesh, cluster, bestIndex);
            highlightMultipleEdges(mesh, cluster, related);

            if (editEdges) applyEdgeStyle();
            else loadEdgeStyleIntoUI(mesh, cluster, bestIndex); 
        }
        return;
    }

    if (!editFaces) loadFacePropertiesFromCluster(clusterMesh, cluster);
    if (!editEdges) loadEdgeStyleIntoUI(clusterMesh, cluster);

    paintClusterFace(clusterMesh, cluster, color, opacity);
    paintClusterEdges(clusterMesh, cluster, style);

    const geometry = clusterMesh.geometry;

    if (boundaryEdges) {
        scene.remove(boundaryEdges);
        boundaryEdges.geometry.dispose();
        boundaryEdges.material.dispose();
        clearBoundaryEdges()
    }

    const edgeAttr = getBoundaryEdges(geometry, cluster);

    if (edgeAttr.count > 0) {
        const boundaryGeo = new THREE.BufferGeometry();
        boundaryGeo.setAttribute("position", edgeAttr);

        const boundaryMat = new THREE.LineBasicMaterial({
            color: 0xff0000,
            linewidth: 1
        });

        setBoundaryEdges(new THREE.LineSegments(boundaryGeo, boundaryMat))

        boundaryEdges.applyMatrix4(clusterMesh.matrixWorld);
        boundaryEdges.material.depthTest = false;
        boundaryEdges.material.depthWrite = false;
        boundaryEdges.renderOrder = 999;

        boundaryEdges.layers.set(HIGHLIGHT_LAYER);
        scene.add(boundaryEdges);
        boundaryEdges.raycast = () => {};
    }
}

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

function applyUIFacePaint() {

    const color = new THREE.Color(colorInput.value);
    const opacity = parseFloat(opacityInput.value);

    if (selectScope === "3D") {
        const clusters = parentToClusters.get(currentSelectedMesh);
        if (!clusters) return;
        clusters.forEach(cm => {
            paintClusterFace(cm, cm.userData.cluster, color, opacity);
        });
    } 
    else {
        if (!currentSelectedMesh || !currentSelectedCluster) return;
        paintClusterFace(currentSelectedMesh, currentSelectedCluster, color, opacity);
    }
}

export function paintClusterFace(mesh, cluster, color, opacity, recordHistory = true) {
    if (selectScope === "1D") return;
    if (!editFaces) return

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

function paintWholeMesh(parent, color, opacity, edgeStyle) {
    const clusters = parentToClusters.get(parent);
    clusters.forEach(cm => {
        paintClusterFace(cm, cm.userData.cluster, color, opacity);
        paintClusterEdges(cm, cm.userData.cluster, edgeStyle);
    });
}