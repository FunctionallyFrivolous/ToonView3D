
let boundaryEdges = null;

const HIGHLIGHT_LAYER = 2;

let currentSelectedMesh = null;
let currentSelectedCluster = null;

const undoStack = [];
const redoStack = [];

let pickMode = false;


let pointerDown = false;
let moved = false;
let downX = 0;
let downY = 0;

const orthoSize = 4;

const edgeStyles = new WeakMap();