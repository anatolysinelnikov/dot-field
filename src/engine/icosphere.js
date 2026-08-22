const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

function normalize([x, y, z]) {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

function midpoint(a, b) {
  return normalize([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
}

export function angularDistance(a, b) {
  return Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
}

function longitudeLatitude([x, y, z]) {
  return [Math.atan2(y, x) * 180 / Math.PI, Math.asin(z) * 180 / Math.PI];
}

const ROOT_POINTS = [
  [-1, GOLDEN_RATIO, 0], [1, GOLDEN_RATIO, 0], [-1, -GOLDEN_RATIO, 0], [1, -GOLDEN_RATIO, 0],
  [0, -1, GOLDEN_RATIO], [0, 1, GOLDEN_RATIO], [0, -1, -GOLDEN_RATIO], [0, 1, -GOLDEN_RATIO],
  [GOLDEN_RATIO, 0, -1], [GOLDEN_RATIO, 0, 1], [-GOLDEN_RATIO, 0, -1], [-GOLDEN_RATIO, 0, 1]
].map(normalize);

const ROOT_FACES = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
];

export class Icosphere {
  constructor(maxLevel) {
    this.maxLevel = maxLevel;
    this.vertexByIdentity = new Map();
    this.vertices = ROOT_POINTS.map((position, index) => {
      const identity = `root-${index}`;
      const vertex = { index, identity, position, lngLat: longitudeLatitude(position) };
      this.vertexByIdentity.set(identity, index);
      return vertex;
    });
    this.levels = [ROOT_FACES.map((vertices, index) => ({ id: `0/${index}`, level: 0, vertices, children: null }))];
  }

  subdivide(face) {
    if (face.children || face.level >= this.maxLevel) return face.children;
    const nextLevel = face.level + 1;
    const midpointId = (left, right) => {
      const leftIdentity = this.vertices[left].identity;
      const rightIdentity = this.vertices[right].identity;
      const endpoints = [leftIdentity, rightIdentity].sort();
      const identity = `midpoint(${endpoints[0]}|${endpoints[1]})`;
      const existing = this.vertexByIdentity.get(identity);
      if (existing !== undefined) return existing;
      const position = midpoint(this.vertices[left].position, this.vertices[right].position);
      const index = this.vertices.length;
      this.vertices.push({ index, identity, position, lngLat: longitudeLatitude(position) });
      this.vertexByIdentity.set(identity, index);
      return index;
    };
    const [a, b, c] = face.vertices;
    const ab = midpointId(a, b);
    const bc = midpointId(b, c);
    const ca = midpointId(c, a);
    const childFaces = [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]];
    face.children = childFaces.map((vertices, index) => ({
      id: `${face.id}/${index}`, level: nextLevel, vertices, children: null
    }));
    (this.levels[nextLevel] ??= []).push(...face.children);
    return face.children;
  }

}
