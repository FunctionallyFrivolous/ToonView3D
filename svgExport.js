
import * as THREE from "https://esm.sh/three@0.164.0";
import {currentModel, scene, renderer, activeCamera, buildClusterMesh } from "./scene.js";
import {paintClusterFace, parentToClusters} from "./faces.js";
import {edgeStyles, edgeOverrides, getBoundaryEdges, buildBoundaryEdgeGraph, persistentEdgeLines, updatePersistentEdgeLinesForCluster} from "./edges.js";

export function exportSVG() {
    if (!currentModel) return;

    const width  = renderer.domElement.width;
    const height = renderer.domElement.height;

    const svgItems = [];

    const clusterMeshes = [];
    currentModel.traverse(o => {
        if (o.isMesh && o.userData.cluster && o.userData.clusterIndex != null) {
            clusterMeshes.push(o);
        }
    });

    const emittedClusterSignatures = new Set();

    function signedArea2D(pts) {
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
            const [x1, y1] = pts[i];
            const [x2, y2] = pts[(i + 1) % pts.length];
            a += (x1 * y2 - x2 * y1);
        }
        return 0.5 * a;
    }

    function centroid2D(pts) {
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

    function centroid3D(points) {
        const c = new THREE.Vector3();
        for (const p of points) c.add(p);
        c.divideScalar(points.length);
        return c;
    }

    for (const mesh of clusterMeshes) {

        const cluster = mesh.userData.cluster;
        const clusterIndex = mesh.userData.clusterIndex;
        if (!cluster || cluster.length === 0) continue;

        const geo    = mesh.geometry;
        const index  = geo.index;
        const colors = geo.attributes.color;

        // --- Face fill color ---
        const f0 = cluster[0];
        const i0 = index.getX(f0 * 3 + 0);

        const lr = colors.getX(i0);
        const lg = colors.getY(i0);
        const lb = colors.getZ(i0);
        const a  = colors.getW(i0);

        const srgb = new THREE.Color(lr, lg, lb).convertLinearToSRGB();
        const fillColor   = `rgb(${Math.round(srgb.r * 255)},${Math.round(srgb.g * 255)},${Math.round(srgb.b * 255)})`;
        const fillOpacity = a;

        // --- Edge style ---
        const style = edgeStyles.get(mesh)?.get(clusterIndex);
        if (!style) continue;

        const strokeColor = style.color.clone().getStyle();

        // --- Boundary edges for fill ---
        const edgeAttr = getBoundaryEdges(geo, cluster);
        if (!edgeAttr || edgeAttr.count === 0) continue;

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

        // --- Build loops ---
        let loops = buildOrderedLoops(segments);
        if (!loops || loops.length === 0) continue;

        // Deduplicate loops
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
        if (loops.length === 0) continue;

        // --- Project loops ---
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

        // --- Classify holes ---
        for (const li of loopInfos) {
            const c = centroid2D(li.projected);
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

        // --- Build SVG path for fill ---
        let d = "";

        for (const li of loopInfos) {
            let pts = li.projected;

            if (!li.isHole) {
                if (li.area < 0) pts = pts.slice().reverse();
            } else {
                if (li.area > 0) pts = pts.slice().reverse();
            }

            d += pts.map((p, i) => {
                const cmd = (i === 0) ? "M" : "L";
                return `${cmd} ${p[0]},${p[1]}`;
            }).join(" ") + " Z ";
        }

        let fillPath = `
            <path d="${d}"
                fill="${fillColor}"
                fill-opacity="${fillOpacity}"
                stroke="none"
                fill-rule="nonzero"
            />
        `;

        // --- STROKES: chain grouping ---
        let edgeGroup = `<g id="cluster-${clusterIndex}-group">`;
        edgeGroup += fillPath;

        const meshOverrides = edgeOverrides.get(mesh);
        const clusterOverrides = meshOverrides ? meshOverrides.get(clusterIndex) : null;

        const chains = collectAllEdgeChains(mesh, cluster);

        for (const chain of chains) {

            let chainStyle = null;
            let chainVisible = false;

            for (const e of chain) {
                const edgeIndex = e.index;

                const s = clusterOverrides && clusterOverrides.get(edgeIndex)
                    ? clusterOverrides.get(edgeIndex)
                    : style;

                if (s.width > 0) {
                    chainVisible = true;
                    chainStyle = s;
                }
            }

            if (!chainVisible || !chainStyle) continue;

            const verts = orderChainVertices(chain);

            const verts3D = verts.map(v => v.clone());
            const smooth3D = smoothChain3D(verts3D, 0.35);

            const verts2D = smooth3D.map(v => {
                const p = v.clone().project(activeCamera);
                return [
                    (p.x * 0.5 + 0.5) * width,
                    (1 - (p.y * 0.5 + 0.5)) * height
                ];
            });

            const dStroke = buildQuadraticBezierPath(verts2D, 0.5);

            const strokeColorChain = chainStyle.color.clone().getStyle();
            const dash = chainStyle.dashed
                ? `stroke-dasharray="${chainStyle.dashScale * 70}"`
                : "";

            edgeGroup += `
                <path d="${dStroke}"
                    fill="none"
                    stroke="${strokeColorChain}"
                    stroke-width="${chainStyle.width}"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    ${dash}
                />
            `;
        }

        edgeGroup += `</g>`;

        // --- Cluster-level dedupe ---
        const clusterSig = [
            fillColor,
            fillOpacity.toFixed(3),
            strokeColor,
            style.width.toFixed(3),
            style.dashed ? style.dashScale.toFixed(3) : "solid",
            clusterGeomSigParts.sort().join("||")
        ].join("::");

        if (emittedClusterSignatures.has(clusterSig)) continue;
        emittedClusterSignatures.add(clusterSig);

        // --- Depth for ordering (world-space centroid projected) ---
        const allWorldPoints = [];
        for (const loop of loops) {
            for (const v of loop) {
                allWorldPoints.push(v); // already world-space
            }
        }
        if (allWorldPoints.length === 0) continue;

        const worldCentroid = centroid3D(allWorldPoints);
        const ndc = worldCentroid.clone().project(activeCamera);
        const depth = ndc.z;

        svgItems.push({ depth, group: edgeGroup });
    }

    svgItems.sort((a, b) => b.depth - a.depth);

    const svgContent = svgItems.map(item => item.group).join("\n");

    return `
        <svg xmlns="http://www.w3.org/2000/svg"
             width="${width}" height="${height}"
             viewBox="0 0 ${width} ${height}">
            ${svgContent}
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

function collectAllEdgeChains(mesh, cluster, maxAngleDeg = 25, maxPct = 0.25) {
    const { edges, vertToEdges } = buildBoundaryEdgeGraph(mesh, cluster);
    const maxAngle = THREE.MathUtils.degToRad(maxAngleDeg);

    const visited = new Set();
    const chains = [];

    for (const start of edges) {
        if (visited.has(start.index)) continue;

        // BFS expansion using your existing rules
        const chain = [];
        const queue = [start];
        visited.add(start.index);

        while (queue.length > 0) {
            const cur = queue.shift();
            chain.push(cur);

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
                    const pctDiff = Math.abs(nb.length - cur.length) / cur.length;
                    if (pctDiff > maxPct) continue;

                    visited.add(nb.index);
                    queue.push(nb);
                }
            }
        }

        chains.push(chain);
    }

    return chains;
}
function orderChainVertices(chain) {
    // Build adjacency by vertex key
    const vertMap = new Map();

    function vKey(p) {
        return `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`;
    }

    for (const e of chain) {
        for (const vk of e.verts) {
            if (!vertMap.has(vk)) vertMap.set(vk, []);
            vertMap.get(vk).push(e);
        }
    }

    // Find endpoints (degree 1)
    const endpoints = [...vertMap.entries()]
        .filter(([k, list]) => list.length === 1)
        .map(([k]) => k);

    let startKey;

    if (endpoints.length >= 1) {
        startKey = endpoints[0]; // open polyline
    } else {
        // closed loop → pick any vertex
        startKey = chain[0].verts[0];
    }

    const ordered = [];
    const visitedEdges = new Set();
    let currentKey = startKey;

    while (true) {
        const edgesAtKey = vertMap.get(currentKey) || [];
        const nextEdge = edgesAtKey.find(e => !visitedEdges.has(e.index));
        if (!nextEdge) break;

        visitedEdges.add(nextEdge.index);

        // Determine direction
        const [k1, k2] = nextEdge.verts;
        const p1 = nextEdge.p1;
        const p2 = nextEdge.p2;

        if (vKey(p1) === currentKey) {
            ordered.push(p1, p2);
            currentKey = vKey(p2);
        } else {
            ordered.push(p2, p1);
            currentKey = vKey(p1);
        }
    }

    return ordered;
}

function buildQuadraticBezierPath(verts2D, alpha = 0.25) {
    if (verts2D.length < 2) return "";

    let d = `M ${verts2D[0][0]},${verts2D[0][1]} `;

    if (verts2D.length === 2) {
        d += `L ${verts2D[1][0]},${verts2D[1][1]}`;
        return d;
    }

    for (let i = 0; i < verts2D.length - 1; i++) {
        const p0 = verts2D[Math.max(0, i - 1)];
        const p1 = verts2D[i];
        const p2 = verts2D[i + 1];

        // Control point halfway between p1 and the midpoint of p0/p2
        const mx = (p0[0] + p2[0]) * 0.5;
        const my = (p0[1] + p2[1]) * 0.5;

        const cx = p1[0] + alpha * (mx - p1[0]);
        const cy = p1[1] + alpha * (my - p1[1]);

        d += `Q ${cx},${cy} ${p2[0]},${p2[1]} `;
    }

    return d;
}

function smoothChain3D(verts3D, alpha = 0.25) {
    if (verts3D.length < 3) return verts3D;

    const smoothed = [verts3D[0]];

    for (let i = 1; i < verts3D.length - 1; i++) {
        const pPrev = verts3D[i - 1];
        const p     = verts3D[i];
        const pNext = verts3D[i + 1];

        const mid = new THREE.Vector3()
            .addVectors(pPrev, pNext)
            .multiplyScalar(0.5);

        const c = new THREE.Vector3()
            .lerpVectors(p, mid, alpha);

        smoothed.push(c);
    }

    smoothed.push(verts3D[verts3D.length - 1]);
    return smoothed;
}

// function computeCentroid(points) {
//     const c = new THREE.Vector3();
//     for (const p of points) c.add(p);
//     c.divideScalar(points.length);
//     return c;
// }

// SILHOUETTE DETECTION
let lastSilhouettes = [];

const clusterMeshes = [];
const clusterIdColor = new Map(); // mesh → THREE.Color

function getClusterMeshes() {
    clusterMeshes.length = 0;
    if (!currentModel) return clusterMeshes;

    let nextId = 1;

    currentModel.traverse(o => {
        if (o.isMesh && o.userData.cluster && o.userData.clusterIndex != null) {
            clusterMeshes.push(o);

            const id = nextId++;
            const r = (id & 0xFF) / 255;
            const g = ((id >> 8) & 0xFF) / 255;
            const b = ((id >> 16) & 0xFF) / 255;

            clusterIdColor.set(o, new THREE.Color(r, g, b));
        }
    });

    return clusterMeshes;
}
const rtWidth  = window.innerWidth;
const rtHeight = window.innerHeight;

const frontRT = new THREE.WebGLRenderTarget(rtWidth, rtHeight);
const backRT  = new THREE.WebGLRenderTarget(rtWidth, rtHeight);

function renderClustersToRT(target, side) {
    const originalMaterials = new Map();

    clusterMeshes.forEach(mesh => {
        originalMaterials.set(mesh, mesh.material);

        const idColor = clusterIdColor.get(mesh);
        mesh.material = new THREE.MeshBasicMaterial({
            color: idColor,
            side: side
        });
    });

    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, activeCamera);
    renderer.setRenderTarget(null);

    // restore materials
    clusterMeshes.forEach(mesh => {
        mesh.material = originalMaterials.get(mesh);
    });
}
function collectVisibleColors(target) {
    const pixels = new Uint8Array(rtWidth * rtHeight * 4);
    renderer.readRenderTargetPixels(target, 0, 0, rtWidth, rtHeight, pixels);

    const seen = new Set();

    for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];

        if (r === 0 && g === 0 && b === 0) continue; // background

        const key = (r) | (g << 8) | (b << 16);
        seen.add(key);
    }

    return seen;
}
function detectSilhouettedClusters() {
    getClusterMeshes();

    // render front and back
    renderClustersToRT(frontRT, THREE.FrontSide);
    renderClustersToRT(backRT,  THREE.BackSide);

    const frontSeen = collectVisibleColors(frontRT);
    const backSeen  = collectVisibleColors(backRT);

    const silhouetted = [];

    clusterMeshes.forEach(mesh => {
        const c = clusterIdColor.get(mesh);
        const r = Math.round(c.r * 255);
        const g = Math.round(c.g * 255);
        const b = Math.round(c.b * 255);
        const key = (r) | (g << 8) | (b << 16);

        if (frontSeen.has(key) && backSeen.has(key)) {
            silhouetted.push(mesh);
        }
    });

    return silhouetted;
}

function computeFrontBackFaces(mesh) {
    const cluster = mesh.userData.cluster;
    const geo = mesh.geometry;
    const index = geo.index;
    const pos = geo.attributes.position;

    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);

    const frontFaces = [];
    const backFaces  = [];

    for (const f of cluster) {
        const i0 = index.getX(f * 3 + 0);
        const i1 = index.getX(f * 3 + 1);
        const i2 = index.getX(f * 3 + 2);

        const v0 = new THREE.Vector3().fromBufferAttribute(pos, i0);
        const v1 = new THREE.Vector3().fromBufferAttribute(pos, i1);
        const v2 = new THREE.Vector3().fromBufferAttribute(pos, i2);

        const centroid = v0.clone().add(v1).add(v2).multiplyScalar(1/3)
            .applyMatrix4(mesh.matrixWorld);

        const n = new THREE.Vector3()
            .subVectors(v1, v0)
            .cross(v2.clone().sub(v0))
            .applyMatrix3(normalMatrix)
            .normalize();

        const viewDir = centroid.clone().sub(activeCamera.position).normalize();
        const dot = n.dot(viewDir);

        if (dot < 0) frontFaces.push(f);
        else        backFaces.push(f);
    }

    return { frontFaces, backFaces };
}
function splitSilhouetteCluster(mesh) {
    const { frontFaces, backFaces } = computeFrontBackFaces(mesh);

    if (!frontFaces.length || !backFaces.length) return null;

    // IMPORTANT: use the cluster mesh itself as the source
    const sourceMesh = mesh; // not mesh.userData.parentMesh

    const frontGeo = buildClusterMesh(sourceMesh, frontFaces);
    const backGeo  = buildClusterMesh(sourceMesh, backFaces);

    const frontMat = mesh.material.clone();
    const backMat  = mesh.material.clone();

    const frontMesh = new THREE.Mesh(frontGeo, frontMat);
    const backMesh  = new THREE.Mesh(backGeo,  backMat);

    // Parent for mapping is still the original parent mesh
    const parent = mesh.userData.parentMesh;
    frontMesh.userData.parentMesh = parent;
    backMesh.userData.parentMesh  = parent;

    // Local clusters in the new geometries: 0..N-1
    frontMesh.userData.cluster = Array.from({ length: frontFaces.length }, (_, i) => i);
    backMesh.userData.cluster  = Array.from({ length: backFaces.length },  (_, i) => i);

    frontMesh.userData.clusterIndex = mesh.userData.clusterIndex + "_front";
    backMesh.userData.clusterIndex  = mesh.userData.clusterIndex + "_back";

    edgeStyles.set(frontMesh, new Map());
    edgeStyles.set(backMesh,  new Map());

    persistentEdgeLines.set(frontMesh, new Map());
    persistentEdgeLines.set(backMesh,  new Map());

    edgeOverrides.set(frontMesh, new Map());
    edgeOverrides.set(backMesh,  new Map());

    return { frontMesh, backMesh };
}

function copyFaceColors(srcMesh, dstMesh, faceList) {
    const srcGeo = srcMesh.geometry;
    const dstGeo = dstMesh.geometry;

    const srcIndex = srcGeo.index;
    const srcColors = srcGeo.attributes.color;

    const dstIndex = dstGeo.index;
    const dstColors = dstGeo.attributes.color;

    for (let f = 0; f < faceList.length; f++) {
        const oldFace = faceList[f];

        const a = srcIndex.getX(oldFace * 3 + 0);
        const b = srcIndex.getX(oldFace * 3 + 1);
        const c = srcIndex.getX(oldFace * 3 + 2);

        const na = dstIndex.getX(f * 3 + 0);
        const nb = dstIndex.getX(f * 3 + 1);
        const nc = dstIndex.getX(f * 3 + 2);

        [ [a,na], [b,nb], [c,nc] ].forEach(([oldI,newI]) => {
            dstColors.setX(newI, srcColors.getX(oldI));
            dstColors.setY(newI, srcColors.getY(oldI));
            dstColors.setZ(newI, srcColors.getZ(oldI));
            dstColors.setW(newI, srcColors.getW(oldI));
        });
    }

    dstColors.needsUpdate = true;
}
function cloneEdgeStyles(srcMesh, dstMesh) {
    const srcIndex = srcMesh.userData.clusterIndex;
    const dstIndex = dstMesh.userData.clusterIndex;

    const srcMap = edgeStyles.get(srcMesh);
    const dstMap = edgeStyles.get(dstMesh);

    const srcStyle = srcMap.get(srcIndex);
    if (srcStyle) {
        dstMap.set(dstIndex, {
            color: srcStyle.color.clone(),
            width: srcStyle.width,
            dashed: srcStyle.dashed,
            dashScale: srcStyle.dashScale
        });
    }

    const srcOverridesMesh = edgeOverrides.get(srcMesh);
    const dstOverridesMesh = edgeOverrides.get(dstMesh);

    const srcOverrides = srcOverridesMesh && srcOverridesMesh.get(srcIndex);
    if (srcOverrides) {
        const dstOverrides = new Map();
        srcOverrides.forEach((style, edgeIndex) => {
            dstOverrides.set(edgeIndex, {
                color: style.color.clone(),
                width: style.width,
                dashed: style.dashed,
                dashScale: style.dashScale
            });
        });
        dstOverridesMesh.set(dstIndex, dstOverrides);
    }

    updatePersistentEdgeLinesForCluster(
        dstMesh,
        dstMesh.userData.cluster,
        edgeStyles.get(dstMesh).get(dstIndex)
    );
}
function replaceClusterMesh(mesh, frontMesh, backMesh) {
    currentModel.remove(mesh);
    currentModel.add(frontMesh);
    currentModel.add(backMesh);

    const parent = mesh.userData.parentMesh;
    const list = parentToClusters.get(parent);

    const idx = list.indexOf(mesh);
    if (idx !== -1) {
        list.splice(idx, 1, frontMesh, backMesh);
    }
}

// DOM

const silhouetteButton = document.getElementById("silhouetteButton");

silhouetteButton.addEventListener("click", () => {
    if (!currentModel) return;

    const silhouettes = detectSilhouettedClusters();
    lastSilhouettes = silhouettes;   // <-- store for Phase 2

    const color = new THREE.Color("#ff00ff");
    const opacity = 0.6;

    silhouettes.forEach(mesh => {
        paintClusterFace(mesh, mesh.userData.cluster, color, opacity, false);
    });
});

const splitButton = document.getElementById("splitSilhouetteButton");

splitButton.addEventListener("click", () => {
    lastSilhouettes.forEach(mesh => {
        const result = splitSilhouetteCluster(mesh);
        if (!result) return;

        const { frontMesh, backMesh } = result;

        const { frontFaces, backFaces } = computeFrontBackFaces(mesh);

        copyFaceColors(mesh, frontMesh, frontFaces);
        copyFaceColors(mesh, backMesh,  backFaces);

        cloneEdgeStyles(mesh, frontMesh);
        cloneEdgeStyles(mesh, backMesh);

        replaceClusterMesh(mesh, frontMesh, backMesh);
    });
});

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