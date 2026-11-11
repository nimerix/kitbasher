import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, LinearSRGBColorSpace } from 'three';
import {
  distinctColor,
  distinctColors,
  hexColor,
  oklchHex,
  partColorModes,
  readPartColorMode,
  sanitizePartColorMode,
  savePartColorMode,
  shownColor,
  swatchBackground,
  swatchColors,
} from '../../src/core/appearance';
import type { Part, PartColorMode } from '../../src/core/types';

const plain = new BoxGeometry(1, 1, 1);
const painted = new BoxGeometry(1, 1, 1);
painted.setAttribute(
  'color',
  new BufferAttribute(new Float32Array(painted.getAttribute('position').count * 3).fill(0.5), 3),
);

const part = (patch: Partial<Part> = {}): Part => ({
  id: 'a',
  name: 'a',
  geometry: plain,
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#aabbcc',
  visible: true,
  locked: false,
  source: 'test',
  ...patch,
});

// Independent sRGB → OKLab (Björn Ottosson), to judge colors without the code under test.
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function oklab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => linear(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675094 * s,
  ];
}
const distance = (x: string, y: string) => {
  const [a, b] = [oklab(x), oklab(y)];
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};
const chroma = (hex: string) => Math.hypot(oklab(hex)[1], oklab(hex)[2]);
const hue = (hex: string) => {
  const [, a, b] = oklab(hex);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
};
const hueGap = (x: number, y: number) => Math.abs(((x - y + 540) % 360) - 180);

/** Whether this OKLCh color is inside the sRGB gamut, computed independently. */
function displayable(lightness: number, c: number, h: number) {
  const a = c * Math.cos((h * Math.PI) / 180),
    b = c * Math.sin((h * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].every((v) => v >= 0 && v <= 1);
}
const maxChroma = (lightness: number, h: number) => {
  let low = 0,
    high = 0.5;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (displayable(lightness, mid, h)) low = mid;
    else high = mid;
  }
  return low;
};

function random(seed: number) {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

afterEach(() => vi.unstubAllGlobals());

describe('the color a part is shown in', () => {
  const editor = '#112233',
    automatic = '#445566';
  // mode, editor color, vertex colors, distinct color → shown color, shown vertex colors
  const cases: [PartColorMode, string | undefined, boolean, string | undefined, string, boolean][] =
    [
      ['material', editor, true, automatic, '#aabbcc', true],
      ['material', editor, false, automatic, '#aabbcc', false],
      ['material', undefined, true, undefined, '#aabbcc', true],
      ['material', undefined, false, automatic, '#aabbcc', false],
      ['editor', editor, true, automatic, editor, false],
      ['editor', editor, false, undefined, editor, false],
      ['editor', undefined, true, automatic, '#aabbcc', true],
      ['editor', undefined, false, automatic, '#aabbcc', false],
      ['distinct', editor, true, automatic, editor, false],
      ['distinct', editor, false, undefined, editor, false],
      ['distinct', undefined, true, automatic, automatic, false],
      ['distinct', undefined, false, automatic, automatic, false],
      ['distinct', undefined, true, undefined, '#aabbcc', true],
      ['distinct', undefined, false, undefined, '#aabbcc', false],
    ];

  it.each(cases)(
    '%s mode, editor color %s, vertex colors %s, distinct %s → %s',
    (mode, displayColor, vertexColors, distinct, color, shownVertexColors) => {
      const subject = part({
        geometry: vertexColors ? painted : plain,
        ...(displayColor ? { displayColor } : {}),
      });
      const before = structuredClone({ ...subject, geometry: null });
      expect(shownColor(subject, mode, distinct)).toEqual({
        color,
        vertexColors: shownVertexColors,
      });
      expect({ ...subject, geometry: null }).toEqual(before);
    },
  );

  it('shows material colors and baked vertex colors in material mode whatever is set', () => {
    const subject = part({ geometry: painted, displayColor: editor });
    expect(shownColor(subject, 'material', automatic)).toEqual({
      color: '#aabbcc',
      vertexColors: true,
    });
  });

  it('lets an editor color win over the automatic distinct color', () => {
    expect(shownColor(part({ displayColor: editor }), 'distinct', automatic).color).toBe(editor);
  });
});

describe('part color modes', () => {
  it('lists the three modes in order with labels', () => {
    expect(partColorModes.map((mode) => mode.id)).toEqual(['material', 'editor', 'distinct']);
    for (const mode of partColorModes) expect(mode.label && mode.description).toBeTruthy();
  });

  it('falls back to editor colors for anything unknown', () => {
    for (const value of [null, undefined, '', 'Material', 'rainbow', 1, {}, ['editor']])
      expect(sanitizePartColorMode(value)).toBe('editor');
    for (const mode of ['material', 'editor', 'distinct'])
      expect(sanitizePartColorMode(mode)).toBe(mode);
  });

  it('remembers the mode, and still works when browser storage is unavailable', () => {
    // Node's own localStorage throws without a backing file, like a locked-down browser.
    expect(readPartColorMode()).toBe('editor');
    expect(() => savePartColorMode('distinct')).not.toThrow();
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    savePartColorMode('distinct');
    expect(values.get('kitbasher.part-colors')).toBe('distinct');
    expect(readPartColorMode()).toBe('distinct');
    values.set('kitbasher.part-colors', 'garbage');
    expect(readPartColorMode()).toBe('editor');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(readPartColorMode()).toBe('editor');
    expect(() => savePartColorMode('material')).not.toThrow();
  });
});

describe('automatic distinct colors', () => {
  const first = Array.from({ length: 256 }, (_, i) => distinctColor(i));

  it('are valid #rrggbb colors', () => {
    for (const color of first) expect(color).toMatch(/^#[\da-f]{6}$/);
    expect(first.every((color) => hexColor.test(color))).toBe(true);
  });

  it('do not depend on the order they were first asked for', async () => {
    vi.resetModules();
    const fresh = await import('../../src/core/appearance');
    // Fill the fresh cache backwards and sparsely.
    const backwards = [200, 63, 17, 8, 0].map((i) => fresh.distinctColor(i));
    expect(backwards).toEqual([200, 63, 17, 8, 0].map((i) => first[i]));
    for (let i = 255; i >= 0; i--) expect(fresh.distinctColor(i)).toBe(first[i]);
  });

  it('give each part a color by scene order, unaffected by moves and appends', () => {
    const parts = ['a', 'b', 'c', 'd'].map((id) => part({ id }));
    const colors = distinctColors(parts);
    expect([...colors.keys()]).toEqual(['a', 'b', 'c', 'd']);
    expect([...colors.values()]).toEqual(first.slice(0, 4));
    const moved = parts.map((p, i) => ({ ...p, position: [i * 100, 5, -3] as Part['position'] }));
    expect(distinctColors(moved)).toEqual(colors);
    const appended = distinctColors([...parts, part({ id: 'e' }), part({ id: 'f' })]);
    for (const [id, color] of colors) expect(appended.get(id)).toBe(color);
    expect(appended.get('e')).toBe(first[4]);
    expect(distinctColors([]).size).toBe(0);
  });

  it('keep neighbors in the parts list far apart', () => {
    for (let i = 1; i < 64; i++) expect(distance(first[i - 1], first[i])).toBeGreaterThan(0.06);
  });

  it('keep a small scene clearly different, and a large one distinguishable', () => {
    const minimum = (n: number) => {
      let least = Infinity;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < i; j++) least = Math.min(least, distance(first[i], first[j]));
      return least;
    };
    // OKLab's just-noticeable difference is about 0.02.
    expect(minimum(8)).toBeGreaterThan(0.14);
    expect(minimum(12)).toBeGreaterThan(0.11);
    expect(minimum(24)).toBeGreaterThan(0.07);
    expect(minimum(64)).toBeGreaterThan(0.04);
    expect(new Set(first).size).toBe(first.length);
  });

  it('stay colorful and in a lightness band that reads on the dark viewport', () => {
    for (const color of first.slice(0, 64)) {
      const [lightness] = oklab(color);
      expect(lightness).toBeGreaterThan(0.6);
      expect(lightness).toBeLessThan(0.87);
      expect(chroma(color)).toBeGreaterThan(0.07);
    }
  });
});

describe('OKLCh to hex', () => {
  it('always returns a displayable #rrggbb color near the requested one', () => {
    const next = random(7);
    for (let i = 0; i < 3000; i++) {
      // Below about 0.15, 8-bit sRGB steps are coarser than the tolerance.
      const lightness = 0.15 + next() * 0.83,
        c = next() * 0.37,
        h = next() * 360;
      const hex = oklchHex(lightness, c, h);
      expect(hex).toMatch(/^#[\da-f]{6}$/);
      const [l] = oklab(hex);
      expect(Math.abs(l - lightness)).toBeLessThan(0.01);
      const shown = chroma(hex);
      // Chroma only ever goes down, and only as far as the gamut needs.
      expect(shown).toBeLessThan(c + 0.006);
      expect(shown).toBeGreaterThan(Math.min(c, maxChroma(lightness, h)) - 0.012);
      if (shown > 0.05) expect(hueGap(hue(hex), h)).toBeLessThan(5);
    }
  });

  it('handles the ends of the lightness range and degenerate chroma', () => {
    expect(oklchHex(0, 0.2, 40)).toBe('#000000');
    expect(oklchHex(1, 0.2, 40)).toBe('#ffffff');
    expect(oklchHex(0.5, 0, 123)).toBe(oklchHex(0.5, 0, 321));
    expect(oklchHex(0.7, -0.1, 30)).toMatch(hexColor);
    expect(oklchHex(0.7, 50, 30)).toMatch(hexColor);
    expect(oklchHex(1.5, 0.1, 30)).toBe('#ffffff');
    expect(oklchHex(-0.5, 0.1, 30)).toBe('#000000');
  });

  it('returns rather than looping forever on a chroma that is not a number', () => {
    expect(oklchHex(0.7, NaN, 30)).toMatch(hexColor);
    expect(oklchHex(0.7, Infinity, 30)).toMatch(hexColor);
  });
});

describe('part swatches', () => {
  const twoTone = (indexed: boolean) => {
    // A large dark face and a small light one.
    const positions = [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 1, 6, 0, 1, 0, 6, 1];
    const colors = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 1, 0, 0, 1, 0, 0, 1, 0, 0];
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
    if (indexed) geometry.setIndex([0, 1, 2, 3, 4, 5]);
    return geometry;
  };
  const dark = `#${new Color().setRGB(0.1, 0.1, 0.1, LinearSRGBColorSpace).getHexString()}`;

  it('show the main vertex colors of a mesh, largest area first', () => {
    for (const indexed of [false, true])
      expect(
        swatchColors(part({ geometry: twoTone(indexed), color: '#ffffff' }), 'editor'),
      ).toEqual([dark, '#ff0000']);
  });

  it('tint vertex colors by the material color', () => {
    const [, red] = swatchColors(part({ geometry: twoTone(false), color: '#808080' }), 'material');
    expect(red).toBe('#800000');
  });

  it('show a single color once an editor or distinct color replaces the vertex colors', () => {
    const geometry = twoTone(false);
    expect(swatchColors(part({ geometry, displayColor: '#123456' }), 'editor')).toEqual([
      '#123456',
    ]);
    expect(swatchColors(part({ geometry }), 'distinct', '#654321')).toEqual(['#654321']);
    expect(swatchColors(part(), 'editor')).toEqual(['#aabbcc']);
  });

  it('paint one color flat and two as a split', () => {
    expect(swatchBackground(['#111111'])).toBe('#111111');
    expect(swatchBackground(['#111111', '#222222'])).toContain('linear-gradient');
  });
});
