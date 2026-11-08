import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
} from 'three';
import { drawLimit, maxBufferBytes } from './geometry';

/**
 * Three's OBJ and text STL loaders need the whole file as one string and keep every number in
 * JavaScript arrays. Chrome caps a string at 512 MiB and a tab's heap at about 4 GiB, so those
 * loaders crash the tab on a 405 MiB OBJ. These read a file in pieces into typed arrays instead.
 */
const readChunkBytes = 16 * 2 ** 20;
const maxLineBytes = 64 * 2 ** 20;
const maxPositionFloats = Math.floor(maxBufferBytes / 4);

/** The file is fine, but this browser cannot use it. Says so instead of calling it damaged. */
export class ImportLimit extends Error {}

const assertDrawable = (floats: number) => {
  if (floats > maxPositionFloats)
    throw new ImportLimit(
      `is too large for a browser to draw. ${drawLimit} Split or decimate it first.`,
    );
};

type OnBytes = (length: number) => void;

const listChunkBits = 16;
const listChunkLength = 1 << listChunkBits;
const listChunkMask = listChunkLength - 1;

/** Grows without copying, because a mesh this large could not spare the memory to. */
class NumberList<T extends Float32Array | Float64Array> {
  private chunks: T[] = [];
  length = 0;
  constructor(private create: (length: number) => T) {}
  push(value: number) {
    const offset = this.length & listChunkMask;
    if (!offset) {
      if (this.length >= 2 ** 32) throw new RangeError('Array buffer allocation failed');
      this.chunks.push(this.create(listChunkLength));
    }
    this.chunks[this.length >>> listChunkBits][offset] = value;
    this.length++;
  }
  at(index: number) {
    return this.chunks[index >>> listChunkBits][index & listChunkMask];
  }
  /** Releases each chunk once it is copied, so the mesh is never held twice in full. */
  take() {
    const result = this.create(this.length);
    for (let i = 0; i < this.chunks.length; i++) {
      const start = i * listChunkLength;
      result.set(this.chunks[i].subarray(0, Math.min(listChunkLength, this.length - start)), start);
      this.chunks[i] = undefined as unknown as T;
    }
    this.chunks = [];
    this.length = 0;
    return result;
  }
}

const floats = () => new NumberList((length) => new Float32Array(length));

const powersOfTen = [
  1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17,
  1e18, 1e19, 1e20, 1e21, 1e22,
];
const decoder = new TextDecoder();
const isSpace = (byte: number) => byte <= 32;

/** Reads whitespace-separated numbers and words from a range of bytes without making strings. */
class Scanner {
  bytes: Uint8Array = new Uint8Array(0);
  at = 0;
  end = 0;
  skipSpaces() {
    while (this.at < this.end && isSpace(this.bytes[this.at])) this.at++;
  }
  skipToken() {
    while (this.at < this.end && !isSpace(this.bytes[this.at])) this.at++;
  }
  /** Matches parseFloat exactly, including on malformed text, which yields NaN or a prefix. */
  number() {
    this.skipSpaces();
    const { bytes, end } = this;
    const start = this.at;
    let i = start;
    const negative = bytes[i] === 45 && i < end;
    if (negative || (bytes[i] === 43 && i < end)) i++;
    let mantissa = 0;
    let digits = 0;
    let exponent = 0;
    for (let digit; i < end && (digit = bytes[i] - 48) >= 0 && digit <= 9; i++, digits++)
      mantissa = mantissa * 10 + digit;
    if (i < end && bytes[i] === 46) {
      i++;
      for (let digit; i < end && (digit = bytes[i] - 48) >= 0 && digit <= 9; i++, digits++) {
        mantissa = mantissa * 10 + digit;
        exponent--;
      }
    }
    let valid = digits > 0;
    if (i < end && (bytes[i] === 101 || bytes[i] === 69)) {
      i++;
      const negativePower = bytes[i] === 45 && i < end;
      if (negativePower || (bytes[i] === 43 && i < end)) i++;
      let power = 0;
      let powerDigits = 0;
      for (let digit; i < end && (digit = bytes[i] - 48) >= 0 && digit <= 9; i++, powerDigits++)
        power = power * 10 + digit;
      if (!powerDigits) valid = false;
      exponent += negativePower ? -power : power;
    }
    // A double holds these operands exactly, so this one operation rounds correctly.
    if (
      valid &&
      mantissa <= 2 ** 53 &&
      exponent >= -22 &&
      exponent <= 22 &&
      (i >= end || isSpace(bytes[i]))
    ) {
      this.at = i;
      const value =
        exponent < 0 ? mantissa / powersOfTen[-exponent] : mantissa * powersOfTen[exponent];
      return negative ? -value : value;
    }
    this.skipToken();
    return parseFloat(decoder.decode(bytes.subarray(start, this.at)));
  }
}

/** Passes the file on in blocks that end at a line break, so no line or number is ever split. */
async function readBlocks(
  file: Blob,
  onBlock: (bytes: Uint8Array, end: number) => void,
  onBytes?: OnBytes,
) {
  let carry: Uint8Array = new Uint8Array(0);
  for (let offset = 0; offset < file.size; offset += readChunkBytes) {
    const chunk = new Uint8Array(await file.slice(offset, offset + readChunkBytes).arrayBuffer());
    let block = chunk;
    if (carry.length) {
      block = new Uint8Array(carry.length + chunk.length);
      block.set(carry);
      block.set(chunk, carry.length);
    }
    const last = block.lastIndexOf(10);
    if (last < 0) carry = block;
    else {
      onBlock(block, last);
      carry = block.subarray(last + 1);
    }
    if (carry.length > maxLineBytes) throw new Error('A line of text is too long to read.');
    onBytes?.(chunk.length);
  }
  if (carry.length) onBlock(carry, carry.length);
}

function attribute(values: Float32Array) {
  return new BufferAttribute(values, 3);
}

const stlHeaderLength = 84;
const stlFaceLength = 50;

function stlIsBinary(head: DataView, size: number) {
  if (size < stlHeaderLength) return false;
  if (stlHeaderLength + head.getUint32(80, true) * stlFaceLength === size) return true;
  // Up to 5 bytes can precede the text, depending on the encoding's byte order mark.
  const text = String.fromCharCode(...new Uint8Array(head.buffer, 0, 10));
  return !text.slice(0, 9).includes('solid');
}

async function readBinaryStl(file: Blob, head: DataView, onBytes?: OnBytes) {
  const faces = head.getUint32(80, true);
  if (stlHeaderLength + faces * stlFaceLength > file.size)
    throw new Error('The file is incomplete. It may not have finished downloading.');
  assertDrawable(faces * 9);
  const positions = new Float32Array(faces * 9);
  const normals = new Float32Array(faces * 9);

  // Materialise Magics stores a default color in the header and a color on each facet.
  let colors: Float32Array | undefined;
  let defaultColor: number[] = [];
  for (let i = 0; i <= 70; i++) {
    if (
      head.getUint32(i) === 0x434f4c4f &&
      head.getUint8(i + 4) === 0x52 &&
      head.getUint8(i + 5) === 0x3d
    ) {
      colors = new Float32Array(faces * 9);
      defaultColor = [
        head.getUint8(i + 6) / 255,
        head.getUint8(i + 7) / 255,
        head.getUint8(i + 8) / 255,
      ];
    }
  }
  const color = new Color();

  const facesPerRead = Math.floor(readChunkBytes / stlFaceLength);
  onBytes?.(stlHeaderLength);
  for (let face = 0; face < faces; face += facesPerRead) {
    const count = Math.min(facesPerRead, faces - face);
    const start = stlHeaderLength + face * stlFaceLength;
    const view = new DataView(await file.slice(start, start + count * stlFaceLength).arrayBuffer());
    for (let i = 0; i < count; i++) {
      const record = i * stlFaceLength;
      const target = (face + i) * 9;
      const nx = view.getFloat32(record, true);
      const ny = view.getFloat32(record + 4, true);
      const nz = view.getFloat32(record + 8, true);
      for (let corner = 0; corner < 9; corner += 3) {
        const source = record + 12 + corner * 4;
        positions[target + corner] = view.getFloat32(source, true);
        positions[target + corner + 1] = view.getFloat32(source + 4, true);
        positions[target + corner + 2] = view.getFloat32(source + 8, true);
        normals[target + corner] = nx;
        normals[target + corner + 1] = ny;
        normals[target + corner + 2] = nz;
      }
      if (colors) {
        const packed = view.getUint16(record + 48, true);
        if (packed & 0x8000)
          color.setRGB(defaultColor[0], defaultColor[1], defaultColor[2], SRGBColorSpace);
        else
          color.setRGB(
            (packed & 0x1f) / 31,
            ((packed >> 5) & 0x1f) / 31,
            ((packed >> 10) & 0x1f) / 31,
            SRGBColorSpace,
          );
        for (let corner = 0; corner < 9; corner += 3) color.toArray(colors, target + corner);
      }
    }
    onBytes?.(count * stlFaceLength);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', attribute(positions));
  geometry.setAttribute('normal', attribute(normals));
  if (colors) geometry.setAttribute('color', attribute(colors));
  return geometry;
}

const tokenIs = (bytes: Uint8Array, start: number, length: number, word: Uint8Array) => {
  if (length !== word.length) return false;
  for (let i = 0; i < length; i++) if (bytes[start + i] !== word[i]) return false;
  return true;
};
const word = (text: string) => new TextEncoder().encode(text);
const vertexWord = word('vertex');
const normalWord = word('normal');
const solidWord = word('solid');
const endFacetWord = word('endfacet');

async function readTextStl(file: Blob, onBytes?: OnBytes) {
  const positions = floats();
  const normals = floats();
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const scanner = new Scanner();
  await readBlocks(
    file,
    (bytes, end) => {
      scanner.bytes = bytes;
      scanner.at = 0;
      scanner.end = end;
      assertDrawable(positions.length);
      for (;;) {
        scanner.skipSpaces();
        if (scanner.at >= end) return;
        const start = scanner.at;
        scanner.skipToken();
        const length = scanner.at - start;
        if (tokenIs(bytes, start, length, vertexWord)) {
          positions.push(scanner.number());
          positions.push(scanner.number());
          positions.push(scanner.number());
          normals.push(nx);
          normals.push(ny);
          normals.push(nz);
        } else if (tokenIs(bytes, start, length, normalWord)) {
          nx = scanner.number();
          ny = scanner.number();
          nz = scanner.number();
        } else if (tokenIs(bytes, start, length, solidWord)) {
          // A solid's name is free text, and could contain words that mean something here.
          const lineEnd = bytes.indexOf(10, scanner.at);
          scanner.at = lineEnd < 0 || lineEnd > end ? end : lineEnd;
        } else if (tokenIs(bytes, start, length, endFacetWord) && positions.length % 9) {
          throw new Error('A facet does not have three vertices.');
        }
      }
    },
    onBytes,
  );
  if (positions.length % 9) throw new Error('The last facet does not have three vertices.');
  assertDrawable(positions.length);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', attribute(positions.take()));
  geometry.setAttribute('normal', attribute(normals.take()));
  return geometry;
}

export async function readStl(file: Blob, onBytes?: OnBytes) {
  const head = new DataView(await file.slice(0, stlHeaderLength).arrayBuffer());
  if (stlIsBinary(head, file.size)) return readBinaryStl(file, head, onBytes);
  if (!decoder.decode(head).includes('solid')) throw new Error('This is not an STL file.');
  return readTextStl(file, onBytes);
}

const noColor = -1;

/** Reads the same subset of OBJ as three's loader that this editor keeps: meshes and colors. */
export async function readObj(file: Blob, onBytes?: OnBytes) {
  const root = new Group();
  // Doubles, because large scan coordinates would give noisy face normals as 32-bit floats.
  const vertices = new NumberList((length) => new Float64Array(length));
  const vertexNormals = floats();
  let vertexColors: ReturnType<typeof floats> | undefined;

  let name = '';
  let declared = false;
  let positions = floats();
  let normals = floats();
  let colors: ReturnType<typeof floats> | undefined;
  // Without a material library, three's loader gives every mesh a white default material.
  const material = new MeshStandardMaterial({ color: '#ffffff' });

  const finishObject = () => {
    if (!positions.length) return;
    assertDrawable(positions.length);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', attribute(positions.take()));
    geometry.setAttribute('normal', attribute(normals.take()));
    if (colors) geometry.setAttribute('color', attribute(colors.take()));
    colors = undefined;
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    root.add(mesh);
  };

  const scanner = new Scanner();
  const faceVertices: number[] = [];
  const faceNormals: number[] = [];
  const vertexCount = () => vertices.length / 3;
  const normalCount = () => vertexNormals.length / 3;

  const integer = () => {
    const { bytes, end } = scanner;
    let i = scanner.at;
    const negative = i < end && bytes[i] === 45;
    if (negative) i++;
    const first = i;
    let value = 0;
    for (let digit; i < end && (digit = bytes[i] - 48) >= 0 && digit <= 9; i++)
      value = value * 10 + digit;
    scanner.at = i;
    if (i === first) return NaN;
    return negative ? -value : value;
  };

  const addCorner = (vertex: number, normalX: number, normalY: number, normalZ: number) => {
    const index = vertex * 3;
    positions.push(vertices.at(index));
    positions.push(vertices.at(index + 1));
    positions.push(vertices.at(index + 2));
    normals.push(normalX);
    normals.push(normalY);
    normals.push(normalZ);
    if (!vertexColors) return;
    const red = vertexColors.at(index);
    if (red !== noColor && !colors) {
      // The first colored corner of this mesh: earlier corners had none, so stay white.
      colors = floats();
      for (let i = 3; i < positions.length; i++) colors.push(1);
    }
    if (!colors) return;
    colors.push(red === noColor ? 1 : red);
    colors.push(red === noColor ? 1 : vertexColors.at(index + 1));
    colors.push(red === noColor ? 1 : vertexColors.at(index + 2));
  };

  const addTriangle = (a: number, b: number, c: number) => {
    const va = faceVertices[a];
    const vb = faceVertices[b];
    const vc = faceVertices[c];
    const na = faceNormals[a];
    const nb = faceNormals[b];
    const nc = faceNormals[c];
    if (na >= 0 && nb >= 0 && nc >= 0) {
      addCorner(
        va,
        vertexNormals.at(na * 3),
        vertexNormals.at(na * 3 + 1),
        vertexNormals.at(na * 3 + 2),
      );
      addCorner(
        vb,
        vertexNormals.at(nb * 3),
        vertexNormals.at(nb * 3 + 1),
        vertexNormals.at(nb * 3 + 2),
      );
      addCorner(
        vc,
        vertexNormals.at(nc * 3),
        vertexNormals.at(nc * 3 + 1),
        vertexNormals.at(nc * 3 + 2),
      );
      return;
    }
    const bx = vertices.at(vb * 3);
    const by = vertices.at(vb * 3 + 1);
    const bz = vertices.at(vb * 3 + 2);
    const cbx = vertices.at(vc * 3) - bx;
    const cby = vertices.at(vc * 3 + 1) - by;
    const cbz = vertices.at(vc * 3 + 2) - bz;
    const abx = vertices.at(va * 3) - bx;
    const aby = vertices.at(va * 3 + 1) - by;
    const abz = vertices.at(va * 3 + 2) - bz;
    const x = cby * abz - cbz * aby;
    const y = cbz * abx - cbx * abz;
    const z = cbx * aby - cby * abx;
    const length = Math.sqrt(x * x + y * y + z * z) || 1;
    addCorner(va, x / length, y / length, z / length);
    addCorner(vb, x / length, y / length, z / length);
    addCorner(vc, x / length, y / length, z / length);
  };

  const readFace = () => {
    const { bytes } = scanner;
    faceVertices.length = 0;
    faceNormals.length = 0;
    for (;;) {
      scanner.skipSpaces();
      if (scanner.at >= scanner.end) break;
      const vertex = integer();
      let normal = NaN;
      if (bytes[scanner.at] === 47 && scanner.at < scanner.end) {
        scanner.at++;
        // A texture coordinate, which this editor does not keep.
        integer();
        if (bytes[scanner.at] === 47 && scanner.at < scanner.end) {
          scanner.at++;
          normal = integer();
        }
      }
      scanner.skipToken();
      const count = vertexCount();
      const index = vertex >= 0 ? vertex - 1 : vertex + count;
      // Also rejects 0 and malformed numbers, which three's loader turned into NaN vertices.
      if (!(index >= 0 && index < count))
        throw new Error('A face uses a vertex that is not in the file.');
      faceVertices.push(index);
      const available = normalCount();
      const normalIndex = normal >= 0 ? normal - 1 : normal + available;
      faceNormals.push(normalIndex >= 0 && normalIndex < available ? normalIndex : -1);
    }
    for (let i = 1; i < faceVertices.length - 1; i++) addTriangle(0, i, i + 1);
  };

  const linear = new Color();
  const readVertex = () => {
    vertices.push(scanner.number());
    vertices.push(scanner.number());
    vertices.push(scanner.number());
    scanner.skipSpaces();
    let hasColor = false;
    if (scanner.at < scanner.end) {
      const red = scanner.number();
      scanner.skipSpaces();
      if (scanner.at < scanner.end) {
        const green = scanner.number();
        scanner.skipSpaces();
        if (scanner.at < scanner.end) {
          const blue = scanner.number();
          hasColor = true;
          if (!vertexColors) {
            vertexColors = floats();
            for (let i = 3; i < vertices.length; i++) vertexColors.push(noColor);
          }
          linear.setRGB(red, green, blue, SRGBColorSpace);
          vertexColors.push(linear.r);
          vertexColors.push(linear.g);
          vertexColors.push(linear.b);
        }
      }
    }
    if (!hasColor && vertexColors) {
      vertexColors.push(noColor);
      vertexColors.push(noColor);
      vertexColors.push(noColor);
    }
  };

  const readLine = (bytes: Uint8Array, start: number, end: number) => {
    scanner.bytes = bytes;
    scanner.at = start;
    scanner.end = end;
    scanner.skipSpaces();
    if (scanner.at >= end) return;
    const first = bytes[scanner.at];
    const second = scanner.at + 1 < end ? bytes[scanner.at + 1] : 32;
    if (first === 118) {
      if (isSpace(second)) {
        scanner.at++;
        readVertex();
      } else if (second === 110 && scanner.at + 2 < end && isSpace(bytes[scanner.at + 2])) {
        scanner.at += 2;
        vertexNormals.push(scanner.number());
        vertexNormals.push(scanner.number());
        vertexNormals.push(scanner.number());
      }
    } else if (first === 102 && isSpace(second)) {
      scanner.at++;
      readFace();
    } else if ((first === 111 || first === 103) && isSpace(second)) {
      scanner.at++;
      scanner.skipSpaces();
      let nameEnd = end;
      while (nameEnd > scanner.at && isSpace(bytes[nameEnd - 1])) nameEnd--;
      const next = decoder.decode(bytes.subarray(scanner.at, nameEnd));
      // Faces before the first declaration belong to it, as they do in three's loader.
      if (declared) {
        finishObject();
        positions = floats();
        normals = floats();
      }
      declared = true;
      name = next;
    }
  };

  let continued: Uint8Array | undefined;
  await readBlocks(
    file,
    (bytes, blockEnd) => {
      assertDrawable(positions.length);
      let start = 0;
      while (start < blockEnd) {
        let end = bytes.indexOf(10, start);
        if (end < 0 || end > blockEnd) end = blockEnd;
        let lineEnd = end;
        if (lineEnd > start && bytes[lineEnd - 1] === 13) lineEnd--;
        if (lineEnd > start && bytes[lineEnd - 1] === 92) {
          // A trailing backslash joins this line to the next one.
          const part = bytes.subarray(start, lineEnd - 1);
          const joined = new Uint8Array((continued?.length ?? 0) + part.length);
          if (continued) joined.set(continued);
          joined.set(part, continued?.length ?? 0);
          continued = joined;
        } else if (continued) {
          const part = bytes.subarray(start, lineEnd);
          const joined = new Uint8Array(continued.length + part.length);
          joined.set(continued);
          joined.set(part, continued.length);
          continued = undefined;
          readLine(joined, 0, joined.length);
        } else readLine(bytes, start, lineEnd);
        start = end + 1;
      }
    },
    onBytes,
  );
  if (continued) readLine(continued, 0, continued.length);
  finishObject();
  return root;
}
