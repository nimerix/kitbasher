import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addLight,
  cloneLighting,
  lightAngles,
  lightingLimits,
  lightingPresetIds,
  lightingPresets,
  matchingPreset,
  positionFromAngles,
  presetLighting,
  readDefaultLighting,
  removeLight,
  sanitizeLighting,
  saveDefaultLighting,
  updateLight,
  reframeLight,
} from '../../src/core/lighting';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { SceneLight, SceneLighting, Vec3 } from '../../src/core/types';

const studio = lightingPresets.studio.lighting;
const pristine = structuredClone(lightingPresets);

const custom: SceneLighting = {
  exposure: 1.35,
  ambient: 0,
  hemisphere: 5,
  sky: '#ABCDEF',
  ground: '#000000',
  shadows: false,
  lights: [
    {
      id: 'sun',
      name: '',
      kind: 'directional',
      color: '#ff8800',
      intensity: 10,
      position: [-0.001, 1e-9, 12345.678],
      range: 0,
      castShadow: true,
      enabled: false,
      camera: false,
    },
    {
      id: 'bulb',
      name: 'Bulb · 電球',
      kind: 'point',
      color: '#00ff7f',
      intensity: 0,
      position: [0, 0, 0],
      range: 1_000_000,
      castShadow: false,
      enabled: true,
      camera: true,
    },
  ],
};

const light = (id: string, patch: Partial<SceneLight> = {}): SceneLight => ({
  id,
  name: id,
  kind: 'directional',
  color: '#ffffff',
  intensity: 1,
  position: [1, 2, 3],
  range: 0,
  castShadow: false,
  enabled: true,
  camera: false,
  ...patch,
});

function memoryStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
  });
  return values;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Nothing a test does may leak into the shared presets.
  expect(lightingPresets).toEqual(pristine);
});

describe('presets', () => {
  it('keep the editor’s original studio rig exactly', () => {
    expect(studio).toEqual({
      exposure: 1,
      ambient: 1,
      hemisphere: 1.25,
      sky: '#e6e9ef',
      ground: '#8b8073',
      shadows: true,
      lights: [
        light('key', {
          name: 'Key',
          position: [90, 150, 90],
          intensity: 2.5,
          color: '#fff1dc',
          castShadow: true,
        }),
        light('rim', { name: 'Rim', position: [-90, 80, -90], intensity: 2.2, color: '#d5e5f4' }),
        light('fill', { name: 'Fill', position: [-90, 40, 90], intensity: 0.6, color: '#ddd0b8' }),
      ],
    });
  });

  it.each(lightingPresetIds)('%s is valid, labeled, and matched only by itself', (id) => {
    const preset = lightingPresets[id];
    expect(preset.label && preset.description).toBeTruthy();
    expect(sanitizeLighting(preset.lighting)).toEqual(preset.lighting);
    expect(new Set(preset.lighting.lights.map((l) => l.id)).size).toBe(
      preset.lighting.lights.length,
    );
    expect(matchingPreset(preset.lighting)).toBe(id);
    expect(matchingPreset(presetLighting(id))).toBe(id);
    // As it comes back from a file or the live view.
    expect(matchingPreset(sanitizeLighting(JSON.parse(JSON.stringify(preset.lighting))))).toBe(id);
  });

  it('hands out copies that cannot change the presets', () => {
    const copy = presetLighting('studio');
    expect(copy).toEqual(studio);
    expect(copy).not.toBe(studio);
    expect(copy.lights[0]).not.toBe(studio.lights[0]);
    expect(copy.lights[0].position).not.toBe(studio.lights[0].position);
    copy.exposure = 3;
    copy.lights[0].position[0] = -1;
    copy.lights[0].color = '#000000';
    copy.lights.push(light('extra'));
    expect(lightingPresets).toEqual(pristine);
  });

  it('are no longer matched after any change', () => {
    const base = presetLighting('studio');
    const key = base.lights[0];
    const edits: SceneLighting[] = [
      { ...base, exposure: 1.05 },
      { ...base, ambient: 0.95 },
      { ...base, hemisphere: 1.3 },
      { ...base, sky: '#e6e9f0' },
      { ...base, ground: '#8b8074' },
      { ...base, shadows: false },
      updateLight(base, 'key', { intensity: 2.55 }),
      updateLight(base, 'key', { position: [90, 150, 90.5] }),
      updateLight(base, 'key', { color: '#fff1dd' }),
      updateLight(base, 'key', { enabled: false }),
      updateLight(base, 'key', { castShadow: false }),
      updateLight(base, 'key', { camera: true }),
      updateLight(base, 'key', { name: 'Key light' }),
      updateLight(base, 'key', { kind: 'point' }),
      updateLight(base, 'key', { range: 10 }),
      removeLight(base, 'fill'),
      addLight(base, 'point')!.lighting,
      { ...base, lights: [base.lights[1], key, base.lights[2]] },
      { ...base, lights: [{ ...key, id: 'key2' }, ...base.lights.slice(1)] },
    ];
    for (const edit of edits) expect(matchingPreset(edit)).toBeNull();
    expect(matchingPreset(base)).toBe('studio');
  });
});

describe('sanitizing lighting', () => {
  it('returns valid lighting value for value, as a copy, and is idempotent', () => {
    const clean = sanitizeLighting(custom);
    expect(clean).toEqual(custom);
    expect(clean).not.toBe(custom);
    expect(clean.lights[0].position).not.toBe(custom.lights[0].position);
    expect(sanitizeLighting(clean)).toEqual(clean);
    expect(sanitizeLighting(JSON.parse(JSON.stringify(custom)))).toEqual(custom);
    for (const id of lightingPresetIds) {
      const once = sanitizeLighting(lightingPresets[id].lighting);
      expect(sanitizeLighting(once)).toEqual(once);
    }
  });

  it('clamps numbers into range', () => {
    const clean = sanitizeLighting({
      ...custom,
      exposure: 0,
      ambient: -3,
      hemisphere: 99,
      lights: [
        light('a', { intensity: -1, range: -5 }),
        light('b', { kind: 'point', intensity: 1e9, range: 1e12 }),
      ],
    });
    expect([clean.exposure, clean.ambient, clean.hemisphere]).toEqual([
      lightingLimits.exposure.min,
      lightingLimits.ambient.min,
      lightingLimits.hemisphere.max,
    ]);
    expect(clean.lights.map((l) => [l.intensity, l.range])).toEqual([
      [lightingLimits.intensity.min, lightingLimits.range.min],
      [lightingLimits.intensity.max, lightingLimits.range.max],
    ]);
    expect(sanitizeLighting({ ...custom, exposure: 5 }).exposure).toBe(4);
  });

  it('falls back field by field for values of the wrong kind', () => {
    const clean = sanitizeLighting({
      exposure: NaN,
      ambient: '2',
      hemisphere: Infinity,
      sky: 'red',
      ground: '#abc',
      shadows: 'yes',
      lights: [
        {
          id: 'x',
          kind: 'directional',
          position: [0, 1, 0],
          name: 7,
          color: '#12345g',
          intensity: null,
          range: '5',
          castShadow: 1,
          enabled: 'false',
          camera: null,
        },
        { id: 'p', kind: 'point', position: [1, 2, 3], color: '#aabbccdd' },
      ],
    });
    expect(clean).toEqual({
      exposure: studio.exposure,
      ambient: studio.ambient,
      hemisphere: studio.hemisphere,
      sky: studio.sky,
      ground: studio.ground,
      shadows: studio.shadows,
      lights: [
        light('x', { name: 'Light', position: [0, 1, 0] }),
        light('p', { name: 'Point', kind: 'point', position: [1, 2, 3] }),
      ],
    });
  });

  it('uses the fallback it is given', () => {
    const soft = lightingPresets.soft.lighting;
    const clean = sanitizeLighting({ sky: 'nope', lights: [] }, soft);
    expect(clean).toEqual({ ...soft, lights: [] });
    expect(sanitizeLighting(null, soft)).toEqual(soft);
    expect(sanitizeLighting(null, soft)).not.toBe(soft);
  });

  it('drops lights it could not draw, and repeated ids', () => {
    const kept = light('kept');
    const clean = sanitizeLighting({
      ...custom,
      lights: [
        null,
        'light',
        42,
        [],
        { ...kept, id: undefined },
        { ...kept, id: '' },
        { ...kept, id: 5 },
        { ...kept, kind: 'spot' },
        { ...kept, kind: undefined },
        { ...kept, position: undefined },
        { ...kept, position: [1, 2] },
        { ...kept, position: [1, 2, 3, 4] },
        { ...kept, position: [1, NaN, 3] },
        { ...kept, position: [1, Infinity, 3] },
        { ...kept, position: ['1', 2, 3] },
        { ...kept, position: { 0: 1, 1: 2, 2: 3, length: 3 } },
        { ...kept, position: [0, 0, 0] },
        { ...kept, position: [-0, 0, -0] },
        kept,
        { ...kept, name: 'Duplicate', position: [9, 9, 9] },
        light('origin', { kind: 'point', position: [0, 0, 0] }),
      ],
    });
    expect(clean.lights).toEqual([kept, light('origin', { kind: 'point', position: [0, 0, 0] })]);
  });

  it(`keeps at most ${lightingLimits.lights} lights, counting only valid ones`, () => {
    const many = Array.from({ length: 12 }, (_, i) => light(`l${i}`));
    const clean = sanitizeLighting({
      ...custom,
      lights: [{ id: 'bad' }, null, light('l0'), ...many],
    });
    expect(clean.lights.map((l) => l.id)).toEqual(many.slice(0, 8).map((l) => l.id));
    expect(sanitizeLighting({ ...custom, lights: 'many' }).lights).toEqual([]);
    expect(sanitizeLighting({ ...custom, lights: { 0: light('a'), length: 1 } }).lights).toEqual(
      [],
    );
  });

  it('keeps only the fields it knows', () => {
    // An own "__proto__" key, as JSON.parse makes from a hostile file.
    const text = JSON.stringify({
      ...custom,
      extra: 1,
      lights: [{ ...custom.lights[0], extra: 2 }],
    }).replace(/^\{/, '{"__proto__":{"polluted":true},');
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toContain('__proto__');
    const clean = sanitizeLighting(parsed);
    expect(Object.keys(clean).sort()).toEqual(Object.keys(custom).sort());
    expect(Object.keys(clean.lights[0]).sort()).toEqual(Object.keys(custom.lights[0]).sort());
    expect(Object.getPrototypeOf(clean)).toBe(Object.prototype);
    expect((clean as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 3],
    ['a string', 'studio'],
    ['true', true],
    ['an array', []],
    ['an array of lights', [light('a')]],
  ])('returns a fresh copy of the fallback for %s', (_name, value) => {
    const clean = sanitizeLighting(value);
    expect(clean).toEqual(studio);
    expect(clean).not.toBe(studio);
    expect(clean.lights).not.toBe(studio.lights);
    clean.lights[0].position[1] = -1;
    clean.lights.pop();
    clean.ambient = 0;
    expect(lightingPresets).toEqual(pristine);
  });
});

describe('editing lights', () => {
  it('adds lights with unique ids until the limit, then refuses', () => {
    let lighting = presetLighting('studio');
    const ids = new Set(lighting.lights.map((l) => l.id));
    while (lighting.lights.length < lightingLimits.lights) {
      const before = lighting;
      const result = addLight(lighting, lighting.lights.length % 2 ? 'point' : 'directional');
      expect(result).not.toBeNull();
      expect(ids.has(result!.id)).toBe(false);
      ids.add(result!.id);
      expect(result!.lighting.lights.at(-1)!.id).toBe(result!.id);
      expect(result!.lighting.lights.slice(0, -1)).toEqual(before.lights);
      expect(before.lights).toHaveLength(result!.lighting.lights.length - 1);
      lighting = result!.lighting;
    }
    expect(addLight(lighting, 'directional')).toBeNull();
    expect(addLight(lighting, 'point', [1, 2, 3])).toBeNull();
    expect(sanitizeLighting(lighting)).toEqual(lighting);
  });

  it('gives a new light usable defaults', () => {
    const empty = { ...presetLighting('studio'), lights: [] };
    const sun = addLight(empty, 'directional')!;
    expect(sun.lighting.lights).toEqual([
      {
        id: sun.id,
        name: 'Light 1',
        kind: 'directional',
        color: '#ffffff',
        intensity: 1.5,
        position: [80, 120, 100],
        range: 0,
        castShadow: false,
        enabled: true,
        camera: false,
      },
    ]);
    const bulb = addLight(sun.lighting, 'point', [5, 6, 7])!;
    expect(bulb.lighting.lights[1]).toEqual({
      id: bulb.id,
      name: 'Point 1',
      kind: 'point',
      color: '#ffffff',
      intensity: 2,
      position: [5, 6, 7],
      range: 0,
      castShadow: false,
      enabled: true,
      camera: false,
    });
    expect(addLight(bulb.lighting, 'point')!.lighting.lights[2]).toMatchObject({
      name: 'Point 2',
      position: [0, 100, 60],
    });
    expect(addLight(bulb.lighting, 'directional')!.lighting.lights[2].name).toBe('Light 2');
    // Defaults are not shared between lights.
    const twice = addLight(addLight(empty, 'point')!.lighting, 'point')!.lighting;
    expect(twice.lights[0].position).not.toBe(twice.lights[1].position);
    expect(empty.lights).toEqual([]);
  });

  it('updates one light without touching the others or the original', () => {
    const before = presetLighting('studio');
    const snapshot = structuredClone(before);
    const after = updateLight(before, 'rim', { intensity: 4, position: [1, 1, 1] });
    expect(before).toEqual(snapshot);
    expect(after.lights[1]).toEqual({ ...before.lights[1], intensity: 4, position: [1, 1, 1] });
    expect(after.lights[0]).toBe(before.lights[0]);
    expect(after.lights[2]).toBe(before.lights[2]);
    expect({ ...after, lights: [] }).toEqual({ ...before, lights: [] });
    expect(updateLight(before, 'missing', { intensity: 9 })).toEqual(before);
  });

  it('removes one light without touching the original', () => {
    const before = presetLighting('studio');
    const after = removeLight(before, 'rim');
    expect(after.lights.map((l) => l.id)).toEqual(['key', 'fill']);
    expect(before.lights).toHaveLength(3);
    expect(removeLight(before, 'missing')).toEqual(before);
    expect(removeLight({ ...before, lights: [] }, 'key').lights).toEqual([]);
  });

  it('copies lighting deeply', () => {
    const copy = cloneLighting(custom);
    expect(copy).toEqual(custom);
    copy.lights[0].position[0] = 99;
    expect(custom.lights[0].position[0]).toBe(-0.001);
  });
});

describe('light angles', () => {
  const close = (a: Vec3, b: Vec3, digits = 9) =>
    a.forEach((value, i) => expect(value).toBeCloseTo(b[i], digits));

  it('measure azimuth from the front toward the right, and elevation from the ground', () => {
    expect(lightAngles([0, 0, 1])).toEqual({ azimuth: 0, elevation: 0 });
    expect(lightAngles([1, 0, 0])).toEqual({ azimuth: 90, elevation: 0 });
    expect(lightAngles([0, 0, -1]).azimuth).toBeCloseTo(180, 12);
    expect(lightAngles([-1, 0, 0]).azimuth).toBeCloseTo(-90, 12);
    expect(lightAngles([0, 5, 0])).toEqual({ azimuth: 0, elevation: 90 });
    expect(lightAngles([0, -5, 0])).toEqual({ azimuth: 0, elevation: -90 });
    expect(lightAngles([3, 3 * Math.SQRT2, 3]).elevation).toBeCloseTo(45, 12);
    expect(lightAngles([0, 0, 0])).toEqual({ azimuth: 0, elevation: 0 });
    close(positionFromAngles(90, 0, 2), [2, 0, 0]);
    close(positionFromAngles(0, 0), [0, 0, 1]);
    close(positionFromAngles(180, 0, 1), [0, 0, -1]);
  });

  it('round-trip angles, and keep the length they are given', () => {
    for (let azimuth = -165; azimuth <= 180; azimuth += 15)
      for (const elevation of [-89.9, -60, -15, 0, 0.001, 30, 75, 89.99]) {
        const length = 0.5 + Math.abs(azimuth) * 3;
        const position = positionFromAngles(azimuth, elevation, length);
        expect(Math.hypot(...position)).toBeCloseTo(length, 9);
        const angles = lightAngles(position);
        expect(angles.azimuth).toBeCloseTo(azimuth, 9);
        expect(angles.elevation).toBeCloseTo(elevation, 9);
      }
  });

  it('round-trip positions, including the presets', () => {
    const positions: Vec3[] = [
      ...lightingPresetIds.flatMap((id) =>
        lightingPresets[id].lighting.lights.map((l) => l.position),
      ),
      [-0.001, 1e-9, 12345.678],
      [1e6, -1e6, 3],
      [-7, -2, -0.5],
    ];
    for (const position of positions) {
      const { azimuth, elevation } = lightAngles(position);
      const back = positionFromAngles(azimuth, elevation, Math.hypot(...position));
      back.forEach((value, i) =>
        expect(Math.abs(value - position[i])).toBeLessThan(1e-9 * Math.hypot(...position) + 1e-12),
      );
    }
  });

  it('reach the poles exactly in elevation and length, whatever the azimuth', () => {
    for (const azimuth of [-180, -90, 0, 33, 90, 180])
      for (const elevation of [90, -90]) {
        const position = positionFromAngles(azimuth, elevation, 250);
        close(position, [0, Math.sign(elevation) * 250, 0], 9);
        expect(Math.hypot(...position)).toBeCloseTo(250, 9);
        expect(lightAngles(position).elevation).toBeCloseTo(elevation, 9);
      }
    // Leaving the pole at a chosen azimuth points that way.
    close(positionFromAngles(90, 89, 1), [
      Math.cos((89 * Math.PI) / 180),
      Math.sin((89 * Math.PI) / 180),
      0,
    ]);
  });
});

describe('the default lighting', () => {
  it('is Studio when browser storage is unavailable, and saving does not throw', () => {
    // Node's own localStorage throws without a backing file, like a locked-down browser.
    const read = readDefaultLighting();
    expect(read).toEqual(studio);
    expect(read).not.toBe(studio);
    expect(() => saveDefaultLighting(custom)).not.toThrow();
    expect(() => saveDefaultLighting(null)).not.toThrow();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(readDefaultLighting()).toEqual(studio);
    expect(() => saveDefaultLighting(custom)).not.toThrow();
    expect(() => saveDefaultLighting(null)).not.toThrow();
  });

  it('remembers the saved default, and forgets it again', () => {
    const values = memoryStorage();
    expect(readDefaultLighting()).toEqual(studio);
    saveDefaultLighting(custom);
    expect(JSON.parse(values.get('kitbasher.lighting')!)).toEqual(custom);
    expect(readDefaultLighting()).toEqual(custom);
    expect(readDefaultLighting()).not.toBe(readDefaultLighting());
    saveDefaultLighting(null);
    expect(values.has('kitbasher.lighting')).toBe(false);
    expect(readDefaultLighting()).toEqual(studio);
  });

  it('ignores a damaged saved default, and repairs a partly damaged one', () => {
    const values = memoryStorage();
    for (const saved of ['{', 'null', '42', '"studio"', '[]', '[{"id":"a"}]', 'undefined']) {
      values.set('kitbasher.lighting', saved);
      expect(readDefaultLighting()).toEqual(studio);
    }
    values.set(
      'kitbasher.lighting',
      JSON.stringify({ ...custom, exposure: 40, sky: 'blue', lights: [{ id: 'x' }, light('y')] }),
    );
    expect(readDefaultLighting()).toEqual({
      ...custom,
      exposure: 4,
      sky: studio.sky,
      lights: [light('y')],
    });
  });
});

describe('reframeLight', () => {
  const camera = new Matrix4().compose(
    new Vector3(120, 80, 260),
    new Quaternion().setFromEuler(new Euler(-0.3, 0.6, 0.1)),
    new Vector3(1, 1, 1),
  );
  const rotation = new Quaternion().setFromRotationMatrix(camera);
  const base = presetLighting('studio').lights[0];

  it('keeps a directional light shining from the same direction when it starts following the camera', () => {
    const followed = reframeLight(base, camera, true);
    expect(followed.camera).toBe(true);
    // The viewport turns a camera light's position into a world direction with the camera's rotation.
    const world = new Vector3().fromArray(followed.position).applyQuaternion(rotation);
    const before = new Vector3().fromArray(base.position);
    expect(world.distanceTo(before)).toBeLessThan(1e-9 * before.length() + 1e-9);
  });

  it('keeps a point light where it was, and returns to the world unchanged', () => {
    const point: SceneLight = {
      ...base,
      kind: 'point',
      position: [30, -12, 45],
      castShadow: false,
    };
    const followed = reframeLight(point, camera, true);
    const world = new Vector3().fromArray(followed.position).applyMatrix4(camera);
    expect(world.distanceTo(new Vector3(30, -12, 45))).toBeLessThan(1e-9);
    const back = reframeLight(followed, camera, false);
    expect(back.camera).toBe(false);
    back.position.forEach((v, i) => expect(v).toBeCloseTo(point.position[i], 9));
  });

  it('leaves a light already in the requested frame alone', () => {
    expect(reframeLight(base, camera, false)).toBe(base);
  });
});
