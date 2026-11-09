import { zlibSync } from 'fflate';
import { Color, Matrix3, Vector3 } from 'three';
import { binaryGeometry, partMatrix, triangleCount } from '../src/core/geometry';
import { viewDirections } from '../src/core/navigation';
import type { ViewName } from '../src/core/navigation';
import type { Part, Vec3 } from '../src/core/types';
import { unionBounds, worldBounds } from './measure';

// A CPU renderer, so agents can see their work without a browser or GPU. It draws orthographic
// views only, which keep the scale bar true and make misalignment easy to judge.

export interface RenderOptions {
  views?: ViewName[];
  /** A custom view, from the target toward the camera. Replaces `views`. */
  direction?: Vec3;
  width?: number;
  height?: number;
  /** Parts to frame; every given part is still drawn. */
  frame?: Part[];
  highlight?: string[];
  labels?: boolean;
  grid?: boolean;
}

export interface RenderedView {
  name: string;
  direction: Vec3;
  mm_per_pixel: number;
  center: Vec3;
}

const supersample = 2;
const background = new Color('#272a2f');
const gridColor = new Color('#50565e');
const xColor = new Color('#e5534b');
const yColor = new Color('#57ab5a');
const zColor = new Color('#539bf5');
const accent = new Color('#ed9b54');

const srgb = (value: number) =>
  Math.round(
    255 *
      (value <= 0.0031308
        ? Math.max(0, value) * 12.92
        : 1.055 * Math.pow(Math.min(1, value), 1 / 2.4) - 0.055),
  );

const niceStep = (value: number) => {
  const power = Math.pow(10, Math.floor(Math.log10(value)));
  const unit = value / power;
  return (unit >= 5 ? 5 : unit >= 2 ? 2 : 1) * power;
};

/** A view's camera basis, with Y up as in the editor. */
function viewBasis(direction: Vec3) {
  const back = new Vector3(...direction).normalize();
  // The named top and bottom views sit just off vertical, so Y up still decides their roll.
  const reference = Math.abs(back.y) > 0.9999999 ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
  const right = reference.clone().cross(back).normalize();
  const up = back.clone().cross(right).normalize();
  return { right, up, back };
}

class Target {
  readonly depth: Float32Array;
  readonly normal: Float32Array;
  readonly albedo: Float32Array;
  readonly ids: Int32Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    const pixels = width * height;
    this.depth = new Float32Array(pixels).fill(-Infinity);
    this.normal = new Float32Array(pixels * 3);
    this.albedo = new Float32Array(pixels * 3);
    this.ids = new Int32Array(pixels).fill(-1);
  }
}

function drawPart(
  target: Target,
  part: Part,
  id: number,
  basis: ReturnType<typeof viewBasis>,
  center: Vector3,
  scale: number,
) {
  const { width, height, depth, normal, albedo, ids } = target;
  if (!part.geometry.getAttribute('normal')) part.geometry.computeVertexNormals();
  const { positions, normals, colors, indices } = binaryGeometry(part.geometry);
  const matrix = partMatrix(part);
  const e = matrix.elements;
  const n = new Matrix3().getNormalMatrix(matrix).elements;
  const mirrored = matrix.determinant() < 0;
  const tint = new Color(part.color);
  const { right, up, back } = basis;
  const vertices = positions.length / 3;
  const sx = new Float32Array(vertices),
    sy = new Float32Array(vertices),
    sz = new Float32Array(vertices);
  const halfWidth = width / 2,
    halfHeight = height / 2;
  for (let i = 0; i < vertices; i++) {
    const x = positions[i * 3],
      y = positions[i * 3 + 1],
      z = positions[i * 3 + 2];
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12] - center.x;
    const wy = e[1] * x + e[5] * y + e[9] * z + e[13] - center.y;
    const wz = e[2] * x + e[6] * y + e[10] * z + e[14] - center.z;
    sx[i] = halfWidth + (wx * right.x + wy * right.y + wz * right.z) * scale;
    sy[i] = halfHeight - (wx * up.x + wy * up.y + wz * up.z) * scale;
    sz[i] = wx * back.x + wy * back.y + wz * back.z;
  }
  const nx = new Float32Array(vertices),
    ny = new Float32Array(vertices),
    nz = new Float32Array(vertices);
  for (let i = 0; i < vertices; i++) {
    const x = normals![i * 3],
      y = normals![i * 3 + 1],
      z = normals![i * 3 + 2];
    const wx = n[0] * x + n[3] * y + n[6] * z;
    const wy = n[1] * x + n[4] * y + n[7] * z;
    const wz = n[2] * x + n[5] * y + n[8] * z;
    const length = Math.hypot(wx, wy, wz) || 1;
    nx[i] = (wx * right.x + wy * right.y + wz * right.z) / length;
    ny[i] = (wx * up.x + wy * up.y + wz * up.z) / length;
    nz[i] = (wx * back.x + wy * back.y + wz * back.z) / length;
  }
  const triangles = indices ? indices.length / 3 : vertices / 3;
  for (let t = 0; t < triangles; t++) {
    const a = indices ? indices[t * 3] : t * 3,
      b = indices ? indices[t * 3 + 1] : t * 3 + 1,
      c = indices ? indices[t * 3 + 2] : t * 3 + 2;
    const ax = sx[a],
      ay = sy[a],
      bx = sx[b],
      by = sy[b],
      cx = sx[c],
      cy = sy[c];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    // Hides back faces as the editor does, so an inside-out mesh looks wrong here too. Screen Y
    // points down, which gives a front face negative area. A mirrored part reverses its winding.
    if (area === 0 || area > 0 === !mirrored) continue;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    if (minX > maxX || minY > maxY) continue;
    const inverse = 1 / area;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inverse;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inverse;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const pz = w0 * sz[a] + w1 * sz[b] + w2 * sz[c];
        const pixel = y * width + x;
        if (pz <= depth[pixel]) continue;
        depth[pixel] = pz;
        ids[pixel] = id;
        const p3 = pixel * 3;
        normal[p3] = w0 * nx[a] + w1 * nx[b] + w2 * nx[c];
        normal[p3 + 1] = w0 * ny[a] + w1 * ny[b] + w2 * ny[c];
        normal[p3 + 2] = w0 * nz[a] + w1 * nz[b] + w2 * nz[c];
        if (colors) {
          albedo[p3] = (w0 * colors[a * 3] + w1 * colors[b * 3] + w2 * colors[c * 3]) * tint.r;
          albedo[p3 + 1] =
            (w0 * colors[a * 3 + 1] + w1 * colors[b * 3 + 1] + w2 * colors[c * 3 + 1]) * tint.g;
          albedo[p3 + 2] =
            (w0 * colors[a * 3 + 2] + w1 * colors[b * 3 + 2] + w2 * colors[c * 3 + 2]) * tint.b;
        } else {
          albedo[p3] = tint.r;
          albedo[p3 + 1] = tint.g;
          albedo[p3 + 2] = tint.b;
        }
      }
    }
  }
}

const keyLight = new Vector3(-0.35, 0.65, 0.68).normalize();
const fillLight = new Vector3(0.7, -0.1, 0.5).normalize();

function shade(target: Target, highlight: Set<number> | null, mmPerPixel: number) {
  const { width, height, depth, normal, albedo, ids } = target;
  const output = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const p3 = pixel * 3;
      const id = ids[pixel];
      if (id < 0) {
        output[p3] = background.r;
        output[p3 + 1] = background.g;
        output[p3 + 2] = background.b;
        continue;
      }
      let nx = normal[p3],
        ny = normal[p3 + 1],
        nz = normal[p3 + 2];
      const length = Math.hypot(nx, ny, nz) || 1;
      // Smoothed normals can tip away from the camera near a silhouette.
      const facing = nz < 0 ? -1 : 1;
      nx = (nx * facing) / length;
      ny = (ny * facing) / length;
      nz = (nz * facing) / length;
      const light =
        0.3 +
        0.6 * Math.max(0, nx * keyLight.x + ny * keyLight.y + nz * keyLight.z) +
        0.22 * Math.max(0, nx * fillLight.x + ny * fillLight.y + nz * fillLight.z) +
        0.1 * (0.5 + 0.5 * ny);
      let r = albedo[p3],
        g = albedo[p3 + 1],
        b = albedo[p3 + 2];
      if (highlight) {
        if (highlight.has(id)) {
          r = r * 0.45 + accent.r * 0.55;
          g = g * 0.45 + accent.g * 0.55;
          b = b * 0.45 + accent.b * 0.55;
        } else {
          const gray = (r + g + b) / 3;
          r = gray * 0.45;
          g = gray * 0.45;
          b = gray * 0.45;
        }
      }
      // Outline silhouettes, part boundaries, and creases, which shading alone can lose.
      let edge = 1;
      const tolerance = (mmPerPixel * 3.5) / Math.max(Math.abs(nz), 0.12);
      for (let side = 0; side < 4; side++) {
        const other =
          side === 0
            ? x + 1 < width
              ? pixel + 1
              : -1
            : side === 1
              ? x > 0
                ? pixel - 1
                : -1
              : side === 2
                ? y + 1 < height
                  ? pixel + width
                  : -1
                : y > 0
                  ? pixel - width
                  : -1;
        if (other < 0) continue;
        const o3 = other * 3;
        if (ids[other] !== id) edge = Math.min(edge, ids[other] < 0 ? 0.3 : 0.4);
        else if (Math.abs(depth[other] - depth[pixel]) > tolerance) edge = Math.min(edge, 0.45);
        else {
          const dot =
            (normal[o3] * normal[p3] +
              normal[o3 + 1] * normal[p3 + 1] +
              normal[o3 + 2] * normal[p3 + 2]) /
            (Math.hypot(normal[o3], normal[o3 + 1], normal[o3 + 2]) * length || 1);
          if (dot < 0.8) edge = Math.min(edge, 0.6);
        }
      }
      output[p3] = r * light * edge;
      output[p3 + 1] = g * light * edge;
      output[p3 + 2] = b * light * edge;
    }
  }
  return output;
}

function drawGround(
  target: Target,
  output: Float32Array,
  basis: ReturnType<typeof viewBasis>,
  center: Vector3,
  scale: number,
  extent: number,
  step: number,
) {
  const { width, height, depth } = target;
  const { right, up, back } = basis;
  const project = (p: Vector3) => {
    const d = p.clone().sub(center);
    return [width / 2 + d.dot(right) * scale, height / 2 - d.dot(up) * scale, d.dot(back)];
  };
  const line = (from: Vector3, to: Vector3, color: Color) => {
    const [ax, ay, az] = project(from),
      [bx, by, bz] = project(to);
    const steps = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      const x = Math.round(ax + (bx - ax) * t),
        y = Math.round(ay + (by - ay) * t),
        z = az + (bz - az) * t;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
      ]) {
        const px = x + dx,
          py = y + dy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const pixel = py * width + px;
        if (z <= depth[pixel]) continue;
        output[pixel * 3] = color.r;
        output[pixel * 3 + 1] = color.g;
        output[pixel * 3 + 2] = color.b;
      }
    }
  };
  const startX = Math.floor((center.x - extent) / step) * step;
  const startZ = Math.floor((center.z - extent) / step) * step;
  const endX = center.x + extent,
    endZ = center.z + extent;
  for (let x = startX; x <= endX; x += step)
    line(new Vector3(x, 0, startZ), new Vector3(x, 0, endZ), x === 0 ? zColor : gridColor);
  for (let z = startZ; z <= endZ; z += step)
    line(new Vector3(startX, 0, z), new Vector3(endX, 0, z), z === 0 ? xColor : gridColor);
}

// 5×7 glyphs, one row per group, written so a wrong pixel can be spotted in the source.
const glyphs: Record<string, string> = {
  ' ': '00000 00000 00000 00000 00000 00000 00000',
  A: '01110 10001 10001 11111 10001 10001 10001',
  B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110',
  D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111',
  F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111',
  H: '10001 10001 10001 11111 10001 10001 10001',
  I: '01110 00100 00100 00100 00100 00100 01110',
  J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001',
  L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001',
  N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101',
  R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110',
  T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110',
  V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 11011 10001',
  X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100',
  Z: '11111 00001 00010 00100 01000 10000 11111',
  '0': '01110 10001 10011 10101 11001 10001 01110',
  '1': '00100 01100 00100 00100 00100 00100 01110',
  '2': '01110 10001 00001 00010 00100 01000 11111',
  '3': '11110 00001 00001 01110 00001 00001 11110',
  '4': '00010 00110 01010 10010 11111 00010 00010',
  '5': '11111 10000 11110 00001 00001 10001 01110',
  '6': '00110 01000 10000 11110 10001 10001 01110',
  '7': '11111 00001 00010 00100 01000 01000 01000',
  '8': '01110 10001 10001 01110 10001 10001 01110',
  '9': '01110 10001 10001 01111 00001 00010 01100',
  '-': '00000 00000 00000 11111 00000 00000 00000',
  '.': '00000 00000 00000 00000 00000 01100 01100',
  _: '00000 00000 00000 00000 00000 00000 11111',
  '+': '00000 00100 00100 11111 00100 00100 00000',
  '/': '00001 00001 00010 00100 01000 10000 10000',
  ':': '00000 01100 01100 00000 01100 01100 00000',
};

class Sheet {
  readonly rgb: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgb = new Uint8Array(width * height * 3);
  }
  set(x: number, y: number, r: number, g: number, b: number) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.rgb[i] = r;
    this.rgb[i + 1] = g;
    this.rgb[i + 2] = b;
  }
  rect(x: number, y: number, w: number, h: number, [r, g, b]: number[]) {
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) this.set(px, py, r, g, b);
  }
  line(ax: number, ay: number, bx: number, by: number, [r, g, b]: number[], weight = 2) {
    const steps = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))) || 1;
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(ax + ((bx - ax) * i) / steps),
        y = Math.round(ay + ((by - ay) * i) / steps);
      this.rect(x, y, weight, weight, [r, g, b]);
    }
  }
  text(value: string, x: number, y: number, size: number, [r, g, b]: number[]) {
    let cursor = x;
    for (const character of value.toUpperCase()) {
      const rows = (glyphs[character] ?? glyphs['-']).split(' ');
      rows.forEach((row, ry) => {
        [...row].forEach((bit, rx) => {
          if (bit === '1') this.rect(cursor + rx * size, y + ry * size, size, size, [r, g, b]);
        });
      });
      cursor += 6 * size;
    }
  }
}

const textWidth = (value: string, size: number) => value.length * 6 * size - size;
const encoded = (color: Color) => [srgb(color.r), srgb(color.g), srgb(color.b)];

function drawLabel(sheet: Sheet, value: string, x: number, y: number, size: number) {
  const width = textWidth(value, size),
    height = 7 * size;
  sheet.rect(x - 3, y - 3, width + 6, height + 6, [24, 26, 29]);
  sheet.text(value, x, y, size, [233, 234, 236]);
}

function drawOverlay(
  sheet: Sheet,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  basis: ReturnType<typeof viewBasis>,
  mmPerPixel: number,
) {
  const size = width >= 400 ? 2 : 1;
  drawLabel(sheet, name, x + 8, y + 8, size);
  // Axis triad, in the same directions as the view.
  const origin = [x + 34, y + height - 34];
  const axes: [string, Vector3, Color][] = [
    ['X', new Vector3(1, 0, 0), xColor],
    ['Y', new Vector3(0, 1, 0), yColor],
    ['Z', new Vector3(0, 0, 1), zColor],
  ];
  for (const [label, axis, color] of axes) {
    const dx = axis.dot(basis.right),
      dy = -axis.dot(basis.up);
    if (Math.hypot(dx, dy) < 0.05) continue;
    const tipX = origin[0] + dx * 24,
      tipY = origin[1] + dy * 24;
    sheet.line(origin[0], origin[1], tipX, tipY, encoded(color));
    sheet.text(
      label,
      Math.round(tipX + dx * 6 - 2),
      Math.round(tipY + dy * 8 - 3),
      1,
      encoded(color),
    );
  }
  // Scale bar.
  const millimeters = niceStep(mmPerPixel * width * 0.22);
  const pixels = millimeters / mmPerPixel;
  const barX = x + width - 12 - pixels,
    barY = y + height - 14;
  const light = [233, 234, 236];
  sheet.rect(Math.round(barX), barY, Math.round(pixels), 2, light);
  sheet.rect(Math.round(barX), barY - 4, 2, 6, light);
  sheet.rect(Math.round(barX + pixels) - 2, barY - 4, 2, 6, light);
  const text = `${Number(millimeters.toPrecision(3))} MM`;
  sheet.text(text, Math.round(barX + pixels - textWidth(text, 1)), barY - 13, 1, light);
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodePng(rgb: Uint8Array, width: number, height: number) {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), row + 1);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array(4 + data.length);
    body.set(new TextEncoder().encode(type));
    body.set(data, 4);
    const result = new Uint8Array(12 + data.length);
    const view = new DataView(result.buffer);
    view.setUint32(0, data.length);
    result.set(body, 4);
    view.setUint32(8 + data.length, crc32(body));
    return result;
  };
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const chunks = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(chunks.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of chunks) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

export function renderScene(parts: Part[], options: RenderOptions = {}) {
  const named: { name: string; direction: Vec3 }[] = options.direction
    ? [{ name: 'custom', direction: options.direction }]
    : (options.views ?? ['iso', 'front', 'right', 'top']).map((name) => ({
        name,
        direction: [...viewDirections[name]] as Vec3,
      }));
  const columns = Math.ceil(Math.sqrt(named.length));
  const rows = Math.ceil(named.length / columns);
  const totalWidth = options.width ?? 1024;
  const totalHeight =
    options.height ?? (rows === columns ? totalWidth : Math.round((totalWidth * rows) / columns));
  const cellWidth = Math.floor((totalWidth - (columns - 1)) / columns);
  const cellHeight = Math.floor((totalHeight - (rows - 1)) / rows);
  const sheet = new Sheet(totalWidth, totalHeight);
  sheet.rect(0, 0, totalWidth, totalHeight, [14, 15, 17]);
  const framed = options.frame?.length ? options.frame : parts;
  const bounds = framed.length
    ? unionBounds(framed)
    : unionBounds([])
        .expandByPoint(new Vector3(-50, 0, -50))
        .expandByPoint(new Vector3(50, 100, 50));
  const worldCenter = bounds.getCenter(new Vector3());
  const span = bounds.getSize(new Vector3());
  const maxSpan = Math.max(span.x, span.y, span.z, 1e-3);
  const views: RenderedView[] = [];
  const highlightIds = options.highlight?.length
    ? new Set(parts.flatMap((part, index) => (options.highlight!.includes(part.id) ? [index] : [])))
    : null;
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(
    (i) =>
      new Vector3(
        i & 1 ? bounds.max.x : bounds.min.x,
        i & 2 ? bounds.max.y : bounds.min.y,
        i & 4 ? bounds.max.z : bounds.min.z,
      ),
  );
  named.forEach(({ name, direction }, index) => {
    const basis = viewBasis(direction);
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const corner of corners) {
      const d = corner.clone().sub(worldCenter);
      const x = d.dot(basis.right),
        y = d.dot(basis.up);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const margin = 0.82;
    const pixelsPerMm =
      Math.min(
        (cellWidth * margin) / Math.max(maxX - minX, maxSpan * 0.02),
        (cellHeight * margin) / Math.max(maxY - minY, maxSpan * 0.02),
      ) * supersample;
    const center = worldCenter
      .clone()
      .addScaledVector(basis.right, (minX + maxX) / 2)
      .addScaledVector(basis.up, (minY + maxY) / 2);
    const target = new Target(cellWidth * supersample, cellHeight * supersample);
    parts.forEach((part, id) => drawPart(target, part, id, basis, center, pixelsPerMm));
    const mmPerPixel = supersample / pixelsPerMm;
    const output = shade(target, highlightIds, mmPerPixel / supersample);
    if (options.grid !== false)
      drawGround(target, output, basis, center, pixelsPerMm, maxSpan * 1.5, niceStep(maxSpan / 8));
    const originX = (index % columns) * (cellWidth + 1);
    const originY = Math.floor(index / columns) * (cellHeight + 1);
    for (let y = 0; y < cellHeight; y++) {
      for (let x = 0; x < cellWidth; x++) {
        const channel = [0, 0, 0];
        for (let sy = 0; sy < supersample; sy++)
          for (let sx = 0; sx < supersample; sx++) {
            const p3 = ((y * supersample + sy) * target.width + x * supersample + sx) * 3;
            channel[0] += output[p3];
            channel[1] += output[p3 + 1];
            channel[2] += output[p3 + 2];
          }
        const samples = supersample * supersample;
        sheet.set(
          originX + x,
          originY + y,
          srgb(channel[0] / samples),
          srgb(channel[1] / samples),
          srgb(channel[2] / samples),
        );
      }
    }
    drawOverlay(sheet, name, originX, originY, cellWidth, cellHeight, basis, mmPerPixel);
    if (options.labels) {
      const size = cellWidth >= 700 ? 2 : 1;
      const taken: [number, number, number, number][] = [];
      for (const part of parts) {
        const partCenter = worldBounds(part).getCenter(new Vector3()).sub(center);
        const label = part.id;
        const x = Math.round(
          originX +
            cellWidth / 2 +
            partCenter.dot(basis.right) / mmPerPixel -
            textWidth(label, size) / 2,
        );
        const y = Math.round(
          originY + cellHeight / 2 - partCenter.dot(basis.up) / mmPerPixel - 3 * size,
        );
        const box: [number, number, number, number] = [
          x - 3,
          y - 3,
          textWidth(label, size) + 6,
          7 * size + 6,
        ];
        const overlaps = taken.some(
          ([ox, oy, ow, oh]) =>
            x - 3 < ox + ow && ox < x - 3 + box[2] && y - 3 < oy + oh && oy < y - 3 + box[3],
        );
        if (overlaps) continue;
        taken.push(box);
        drawLabel(sheet, label, x, y, size);
      }
    }
    views.push({
      name,
      direction,
      mm_per_pixel: Number(mmPerPixel.toPrecision(4)),
      center: center.toArray().map((value) => Number(value.toFixed(3))) as Vec3,
    });
  });
  return {
    png: encodePng(sheet.rgb, totalWidth, totalHeight),
    rgb: sheet.rgb,
    width: totalWidth,
    height: totalHeight,
    views,
    triangles: parts.reduce((total, part) => total + triangleCount(part.geometry), 0),
    grid_mm: options.grid === false ? undefined : niceStep(maxSpan / 8),
  };
}
