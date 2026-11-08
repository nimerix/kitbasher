import { describe, expect, it } from 'vitest';
import { BufferGeometry, Mesh, Object3D } from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { readObj, readStl } from '../../src/core/model-readers';

const meshes = (root: Object3D) => {
  const found: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) found.push(object);
  });
  return found;
};

function expectSameGeometry(actual: BufferGeometry, expected: BufferGeometry) {
  for (const name of ['position', 'normal', 'color']) {
    const a = actual.getAttribute(name);
    const b = expected.getAttribute(name);
    expect(!!a, `${name} present`).toBe(!!b);
    if (!a || !b) continue;
    expect(a.count, `${name} count`).toBe(b.count);
    expect(Array.from(a.array as Float32Array), name).toEqual(Array.from(b.array as Float32Array));
  }
}

async function expectObjMatchesThree(text: string) {
  const actual = meshes(await readObj(new Blob([text])));
  const expected = meshes(new OBJLoader().parse(text));
  expect(actual.map((mesh) => mesh.name)).toEqual(expected.map((mesh) => mesh.name));
  actual.forEach((mesh, i) => expectSameGeometry(mesh.geometry, expected[i].geometry));
  return actual;
}

const square = `v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
`;

describe('OBJ reader matches three.js', () => {
  it('reads triangles and computes the face normal', async () => {
    const [mesh] = await expectObjMatchesThree(`${square}f 1 2 3\n`);
    const normal = mesh.geometry.getAttribute('normal');
    expect([normal.getX(0), normal.getY(0), normal.getZ(0)]).toEqual([0, -0, 1]);
  });

  it('fans polygons', async () => {
    const [mesh] = await expectObjMatchesThree(`${square}f 1 2 3 4\n`);
    expect(mesh.geometry.getAttribute('position').count).toBe(6);
  });

  it('reads negative, texture, and normal references', async () => {
    await expectObjMatchesThree(`${square}vt 0 0
vt 1 0
vt 1 1
vn 0 0 1
vn 0 1 0
vn 1 0 0
f -4 -3 -2
f 1/1 2/2 3/3
f 1//1 2//2 3//3
f 1/1/1 2/2/2 3/3/3
f -4/-3/-3 -3/-2/-2 -2/-1/-1
`);
  });

  it('splits meshes on o and g, keeping faces before the first declaration', async () => {
    const parts = await expectObjMatchesThree(`${square}f 1 2 3
o Named object
f 1 3 4
g  spaced group name  \nf 1 2 3
g
f 1 2 4
o empty
o last
f 2 3 4
`);
    expect(parts.map((mesh) => mesh.name)).toEqual([
      'Named object',
      'spaced group name',
      '',
      'last',
    ]);
  });

  it('shares vertices across objects', async () => {
    await expectObjMatchesThree(`o a\n${square}f 1 2 3\no b\nf 1 3 4\nv 2 2 2\nf -1 1 2\n`);
  });

  it('reads vertex colors in linear space', async () => {
    const [mesh] = await expectObjMatchesThree(`v 0 0 0 1 0 0
v 1 0 0 0 1 0
v 0 1 0 0.5 0.5 0.5
f 1 2 3
`);
    expect(mesh.geometry.getAttribute('color').getX(2)).toBeLessThan(0.5);
  });

  it('ignores a homogeneous coordinate rather than taking it for a color', async () => {
    await expectObjMatchesThree(`v 0 0 0 1\nv 1 0 0 1\nv 0 1 0 1\nf 1 2 3\n`);
  });

  it('handles the number formats real exporters write', async () => {
    await expectObjMatchesThree(`v 1e-3 -2.5E+2 +3.25
v .5 5. -.25
v 0.1234567890123456789 1234567890123456789012 1e-300
v 1.17549435e-38 3.4028234e38 0.30000000000000004
f 1 2 3
f 2 3 4
`);
  });

  it('handles line endings, comments, continuations, and other statements', async () => {
    await expectObjMatchesThree(
      '# comment\r\no first\r\nmtllib scan.mtl\r\n\r\n  v 0 0 0\r\nv 1\t0  0\r\n\tv 0 1 0\r\nusemtl skin\r\ns off\r\nf 1 \\\r\n2 3\r\nf 1 2 \\\n3\no lines\nl 1 2\no points\np 1\n',
    );
  });

  it('keeps faces that share an object with lines or points, unlike three.js', async () => {
    const text = `${square}f 1 2 3\nl 1 2\np 1\n`;
    expect(meshes(new OBJLoader().parse(text))).toHaveLength(0);
    expect(meshes(await readObj(new Blob([text])))).toHaveLength(1);
  });

  it('reads a last line without a line break, and a NUL terminator', async () => {
    await expectObjMatchesThree(`${square}f 1 2 3`);
    await expectObjMatchesThree(`${square}f 1 2 3\n\0`);
  });

  it('skips files and faces with nothing to draw', async () => {
    expect(await expectObjMatchesThree('# nothing\n')).toHaveLength(0);
    expect(await expectObjMatchesThree(`${square}f 1 2\n`)).toHaveLength(0);
  });

  it('keeps numbers intact across read boundaries', async () => {
    const lines = ['o large'];
    for (let i = 0; i < 700000; i++) lines.push(`v ${i}.25 ${-i}.5 ${i}.125`);
    for (let i = 1; i < 300000; i += 3) lines.push(`f ${i} ${i + 1} ${i + 2}`);
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(16 * 2 ** 20);
    await expectObjMatchesThree(text);
  });

  it('colors a mesh only where the file does, instead of misaligning like three.js', async () => {
    const root = await readObj(
      new Blob(['v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1 1 0 0\nf 1 2 3\nf 2 3 4\n']),
    );
    const colors = meshes(root)[0].geometry.getAttribute('color');
    expect(colors.count).toBe(6);
    expect(Array.from(colors.array).slice(0, 15)).toEqual(Array(15).fill(1));
    expect([colors.getX(5), colors.getY(5), colors.getZ(5)]).toEqual([1, 0, 0]);
  });

  it('rejects faces that use missing vertices', async () => {
    for (const face of ['f 1 2 9', 'f 0 1 2', 'f -9 1 2', 'f a b c'])
      await expect(readObj(new Blob([`${square}${face}\n`]))).rejects.toThrow(
        'A face uses a vertex',
      );
  });

  it('keeps malformed coordinates as NaN so the importer can reject them', async () => {
    const [mesh] = meshes(await readObj(new Blob(['v nope 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'])));
    expect(mesh.geometry.getAttribute('position').getX(0)).toBeNaN();
  });

  it('refuses binary data posing as text instead of holding all of it', async () => {
    const blob = new Blob(Array.from({ length: 9 }, () => new Uint8Array(8 * 2 ** 20).fill(65)));
    await expect(readObj(blob)).rejects.toThrow('too long');
  });
});

function binaryStl(triangles: number[][][], header = 'binary', attribute: number[] = []) {
  const data = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(data);
  new TextEncoder().encodeInto(header, new Uint8Array(data, 0, 80));
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, face) => {
    const start = 84 + face * 50;
    view.setFloat32(start + 8, 1, true);
    triangle.flat().forEach((value, i) => view.setFloat32(start + 12 + i * 4, value, true));
    view.setUint16(start + 48, attribute[face] ?? 0, true);
  });
  return data;
}

const triangles = [
  [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  [
    [1.5, 0.25, -3],
    [1, 1, 1],
    [0, 1, 2e-7],
  ],
];

describe('STL reader matches three.js', () => {
  it('reads binary files', async () => {
    const data = binaryStl(triangles);
    expectSameGeometry(await readStl(new Blob([data])), new STLLoader().parse(data));
  });

  it('reads binary files whose header begins with "solid"', async () => {
    const data = binaryStl(triangles, 'solid export from a CAD system');
    expectSameGeometry(await readStl(new Blob([data])), new STLLoader().parse(data));
  });

  it('reads per-facet and default binary colors', async () => {
    const header = 'COLOR=\xff\x80\x40\xff';
    const data = binaryStl(triangles, header, [0x0000 | 31 | (15 << 5), 0x8000]);
    new Uint8Array(data).set([...header].map((c) => c.charCodeAt(0)));
    const actual = await readStl(new Blob([data]));
    expect(actual.getAttribute('color')).toBeTruthy();
    expectSameGeometry(actual, new STLLoader().parse(data));
  });

  it('crosses read boundaries in binary files', async () => {
    const many = Array.from({ length: 400000 }, (_, i) => [
      [i, 0, 0],
      [i + 1, 0.5, 0],
      [i, 1, 0.25],
    ]);
    const data = binaryStl(many);
    expect(data.byteLength).toBeGreaterThan(16 * 2 ** 20);
    expectSameGeometry(await readStl(new Blob([data])), new STLLoader().parse(data));
  });

  it('reads text files, however they are laid out', async () => {
    const facet = `facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 -1.5e-2
    vertex 0 1 0
  endloop
endfacet
`;
    for (const text of [
      `solid part\n${facet}${facet}endsolid part\n`,
      `solid vertex 9 9 9 normal 1 1 1\n${facet}endsolid\n`,
      `solid a\n${facet}endsolid a\nsolid b\n${facet}endsolid b\n`,
      `solid a\r\n${facet.replace(/\n/g, '\r\n')}endsolid a\r\n`,
      `solid one line\n${facet.replace(/\s+/g, ' ')}\nendsolid\n`,
    ])
      expectSameGeometry(await readStl(new Blob([text])), new STLLoader().parse(text));
  });

  it('reports the truncated file three.js fails on with a bounds error', async () => {
    const data = binaryStl(triangles).slice(0, 100);
    await expect(readStl(new Blob([data]))).rejects.toThrow('incomplete');
  });

  it('does not allocate what a damaged header claims', async () => {
    const data = binaryStl(triangles);
    new DataView(data).setUint32(80, 0xffffffff, true);
    await expect(readStl(new Blob([data]))).rejects.toThrow('incomplete');
  });

  it('reports malformed facets', async () => {
    await expect(
      readStl(
        new Blob([
          'solid a\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nendloop\nendfacet\nendsolid',
        ]),
      ),
    ).rejects.toThrow('three vertices');
  });

  it('rejects data that is neither kind of STL', async () => {
    await expect(readStl(new Blob(['x']))).rejects.toThrow('not an STL');
  });
});
