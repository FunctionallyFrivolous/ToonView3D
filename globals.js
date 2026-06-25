
let boundaryEdges = null;

const HIGHLIGHT_LAYER = 2;

let currentSelectedMesh = null;
let currentSelectedCluster = null;

let currentSelectedEdge = null; // { mesh, cluster, edgeIndex, p1, p2 }
let edgeHighlightLine = null;        // LineSegments2 for selected edge

const undoStack = [];
const redoStack = [];

let pickMode = false;

let pointerDown = false;
let moved = false;
let downX = 0;
let downY = 0;

const orthoSize = 4;

const edgeStyles = new WeakMap();

let currentModel = null;
let currentEdgeLayers = [];

let edgeDepthBias = 0.0001;


