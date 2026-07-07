import * as THREE from "https://esm.sh/three@0.164.0";

import {
    editEdges,
    getBoundaryEdges,
    closestPointOnSegment, collectRelatedEdges, 
    loadEdgeStyleIntoUI,
    getEdgeStyle, deselectEdge,
    highlightSelectedEdges, selectedEdges, applyEdgeStyleToSelectedEdges,
    selectClusterBoundaryEdges, selectMeshBoundaryEdges,
    canonicalEdgeKey, globalEdgeMap
} from "./edges.js";

import { selectScope, scene, undoStack, redoStack} from "./scene.js";


export const parentToClusters = new WeakMap();

export let currentSelectedMesh = null;

export let currentSelectedCluster = null;
export const selectedFaces = new Set();

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

export function highlightSelectedFaces() {
    // Clear old highlights
    if (meshHighlights.length > 0) {
        meshHighlights.forEach(h => {
            scene.remove(h);
            h.geometry.dispose();
            h.material.dispose();
        });
        meshHighlights = [];
    }

    if (selectedFaces.size === 0) return;

    for (const sel of selectedFaces) {
        const { mesh, cluster, faceIndex } = sel;

        const geo = mesh.geometry;
        const index = geo.index;
        const pos = geo.attributes.position;

        const i0 = index.getX(faceIndex * 3 + 0);
        const i1 = index.getX(faceIndex * 3 + 1);
        const i2 = index.getX(faceIndex * 3 + 2);

        const p0 = new THREE.Vector3().fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
        const p1 = new THREE.Vector3().fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
        const p2 = new THREE.Vector3().fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);

        const positions = [
            p0.x, p0.y, p0.z, p1.x, p1.y, p1.z,
            p1.x, p1.y, p1.z, p2.x, p2.y, p2.z,
            p2.x, p2.y, p2.z, p0.x, p0.y, p0.z
        ];

        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

        const lineMat = new THREE.LineBasicMaterial({
            color: 0xff0000,
            linewidth: 2,
            depthTest: false,
            depthWrite: false
        });

        const line = new THREE.LineSegments(lineGeo, lineMat);
        line.renderOrder = 999;

        // Prevent highlight from blocking raycasts
        line.raycast = () => {};

        scene.add(line);
        meshHighlights.push(line);
    }
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

    // 3D: unified edge selection for entire mesh
    if (selectScope === "3D") {
        const parent = clusterMesh.userData.parentMesh;

        // Toggle: if any edge from this mesh is selected, deselect all of them
        let meshAlreadySelected = false;

        for (const s of selectedEdges) {
            if (s.mesh.userData.parentMesh === parent) {
                meshAlreadySelected = true;
                break;
            }
        }

        if (meshAlreadySelected) {
            const toRemove = [];
            for (const s of selectedEdges) {
                if (s.mesh.userData.parentMesh === parent) {
                    toRemove.push(s);
                }
            }
            toRemove.forEach(s => selectedEdges.delete(s));
        } else {
            selectMeshBoundaryEdges(parent);
        }

        currentSelectedMesh = parent;
        currentSelectedCluster = null;

        highlightSelectedEdges();

        if (editEdges) {
            applyEdgeStyleToSelectedEdges();
        } else {
            loadEdgeStyleIntoUI(clusterMesh, clusterMesh.userData.cluster, 0);
        }

        paintWholeMesh(parent, color, opacity, style)

        return;
    }

    // 1D: edge multi-select (with related-edge chain selection, robust across 2D/3D)
    if (selectScope === "1D") {
        let mesh = clusterMesh;
        const clickPoint = hit.point.clone();

        const edgeAttr = getBoundaryEdges(mesh.geometry, cluster);
        const arr = edgeAttr.array;

        let bestIndex = -1;
        let bestDist = Infinity;

        // Find nearest edge
        for (let i = 0; i < arr.length; i += 6) {
            const edgeIndex = i / 6;

            const p1 = new THREE.Vector3(arr[i], arr[i+1], arr[i+2]).applyMatrix4(mesh.matrixWorld);
            const p2 = new THREE.Vector3(arr[i+3], arr[i+4], arr[i+5]).applyMatrix4(mesh.matrixWorld);

            const cp = closestPointOnSegment(clickPoint, p1, p2);
            const dist = cp.distanceTo(clickPoint);

            if (dist < bestDist) {
                bestDist = dist;
                bestIndex = edgeIndex;
            }
        }

        if (bestIndex !== -1) {
            // 1) Get related edges (curvature-aware chain)
            const related = collectRelatedEdges(mesh, cluster, bestIndex);

            // 2) For each related edge, toggle all its twins via globalEdgeMap
            for (const ei of related) {
                const i = ei * 6;

                const p1World = new THREE.Vector3(arr[i], arr[i+1], arr[i+2]).applyMatrix4(mesh.matrixWorld);
                const p2World = new THREE.Vector3(arr[i+3], arr[i+4], arr[i+5]).applyMatrix4(mesh.matrixWorld);

                const key = canonicalEdgeKey(p1World, p2World);

                const twins = globalEdgeMap.get(key) || [];

                // Determine if this edge (any twin) is currently selected
                let anySelected = false;
                for (const twin of twins) {
                    for (const s of selectedEdges) {
                        if (s.mesh === twin.mesh && s.edgeIndex === twin.edgeIndex) {
                            anySelected = true;
                            break;
                        }
                    }
                    if (anySelected) break;
                }

                if (anySelected) {
                    // Deselect all twins
                    const toRemove = [];
                    for (const twin of twins) {
                        for (const s of selectedEdges) {
                            if (s.mesh === twin.mesh && s.edgeIndex === twin.edgeIndex) {
                                toRemove.push(s);
                            }
                        }
                    }
                    toRemove.forEach(s => selectedEdges.delete(s));
                } else {
                    // Select all twins
                    for (const twin of twins) {
                        // Avoid duplicates
                        let exists = false;
                        for (const s of selectedEdges) {
                            if (s.mesh === twin.mesh && s.edgeIndex === twin.edgeIndex) {
                                exists = true;
                                break;
                            }
                        }
                        if (!exists) {
                            selectedEdges.add({
                                mesh: twin.mesh,
                                cluster: twin.mesh.userData.cluster,
                                edgeIndex: twin.edgeIndex
                            });
                        }
                    }
                }
            }

            highlightSelectedEdges();

            if (editEdges) {
                applyEdgeStyleToSelectedEdges();
            } else {
                loadEdgeStyleIntoUI(mesh, cluster, bestIndex);
            }
        }

        return;
    }

    // 2D: unified edge selection for cluster boundaries
    if (selectScope === "2D") {

        const mesh = clusterMesh;
        const cluster = mesh.userData.cluster;

        currentSelectedMesh = clusterMesh;
        currentSelectedCluster = cluster;

        // Toggle cluster selection: if any boundary edge is selected, deselect all
        let clusterAlreadySelected = false;

        for (const s of selectedEdges) {
            if (s.mesh === mesh && s.cluster === cluster) {
                clusterAlreadySelected = true;
                break;
            }
        }

        if (clusterAlreadySelected) {
            // Remove all edges belonging to this cluster
            const toRemove = [];
            for (const s of selectedEdges) {
                if (s.mesh === mesh && s.cluster === cluster) {
                    toRemove.push(s);
                }
            }
            toRemove.forEach(s => selectedEdges.delete(s));
        } else {
            // Add all boundary edges of this cluster
            selectClusterBoundaryEdges(mesh, cluster);
        }

        // Update highlight
        highlightSelectedEdges();

        // Apply edge style if in edit mode
        if (editEdges) {
            applyEdgeStyleToSelectedEdges();
        } else {
            loadEdgeStyleIntoUI(mesh, cluster, 0);
        }

        if (!editFaces) loadFacePropertiesFromCluster(clusterMesh, cluster);
        if (!editEdges) loadEdgeStyleIntoUI(mesh, cluster, hit.point); //loadEdgeStyleIntoUI(clusterMesh, cluster);

        paintClusterFace(clusterMesh, cluster, color, opacity);

        return;
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
    });
}