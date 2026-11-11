# Scene file format

`.kitbash` files store an assembly as a small JSON header followed by raw binary mesh
data. Text cannot hold large scenes: a single JavaScript string tops out near 512 MB, and
one 5-million-triangle scan needs more than that as JSON.

Files saved by earlier versions are JSON (`version: 1`). They still open, and new files
are always written in this format, so the reader sees one current format plus that one
legacy format.

## Layout

All integers and mesh data are little-endian.

| Offset | Size | Contents                                                    |
| ------ | ---- | ----------------------------------------------------------- |
| 0      | 8    | Magic: `KITBASH` followed by byte `0x1A`                    |
| 8      | 4    | Format version, `uint32`, currently `2`                     |
| 12     | 4    | Reserved, zero                                              |
| 16     | 8    | Header length in bytes, `uint64`                            |
| 24     | n    | Header: UTF-8 JSON, padded with spaces to a 4-byte boundary |
| 24 + n | m    | Body: mesh sections                                         |

### Header

```jsonc
{
  "format": "kitbasher",
  "version": 2,
  "units": "mm",
  "name": "Scout · MK.04",
  // Part fields as in the scene, with `geometry` as an index into `geometries`.
  "parts": [
    { "id": "torso", "name": "Torso shell", "geometry": 0, "displayColor": "#3f7fd8" /* … */ },
  ],
  "joints": [],
  "constraints": [],
  // Only when the scene has lighting of its own.
  "lighting": {
    "exposure": 1,
    "ambient": 1,
    "hemisphere": 1.25,
    "sky": "#e6e9ef",
    "ground": "#8b8073",
    "shadows": true,
    "lights": [
      {
        "id": "key",
        "name": "Key",
        "kind": "directional",
        "color": "#fff1dc",
        "intensity": 2.5,
        "position": [90, 150, 90],
        "range": 0,
        "castShadow": true,
        "enabled": true,
        "camera": false,
      },
    ],
  },
  "geometries": [
    {
      "vertices": 1200,
      // Offsets are bytes from the start of the body.
      "positions": { "offset": 0, "length": 14400 },
      "normals": { "offset": 14400, "length": 14400 },
      "colors": { "offset": 28800, "length": 14400 },
      "indices": { "offset": 43200, "length": 3600, "type": "u16" },
    },
  ],
  "bodyLength": 46800,
}
```

### Body

- `positions`, `normals`, and `colors` are `float32` triples, 12 bytes per vertex.
  Only `positions` is required; normals are computed when absent.
- `indices` is `uint16` or `uint32`, three per triangle. Without it, every three vertices
  form a triangle.
- Each section starts on a 4-byte boundary and is padded with zeros to the next one.
- Parts that share a mesh, such as pasted copies, refer to the same `geometries` entry.
  The mesh is stored once and stays shared after reopening.

### Editor colors and lighting

Both are optional and only change how the editor draws the scene. No export contains either:
GLB, STL, 3MF, and the Blender package use each part's `color`, the material color. A file
without them opens with no editor colors and the default lighting, so files written before them
open unchanged.

- `parts[].displayColor` is the part's editor color, `#rrggbb`. It is absent when the part has
  none. Any other value is dropped when the file opens.
- `lighting` is present only once the scene has lighting of its own. Without it, the editor
  uses the default lighting saved in that browser, or the Studio preset.

| `lighting` field | Value              | Meaning                                                    |
| ---------------- | ------------------ | ---------------------------------------------------------- |
| `exposure`       | 0.1 to 4           | Brightness, the renderer's tone-mapping exposure           |
| `ambient`        | 0 to 5             | Ambient light intensity                                    |
| `hemisphere`     | 0 to 5             | Sky fill intensity                                         |
| `sky`, `ground`  | `#rrggbb`          | Sky fill colors from above and from below                  |
| `shadows`        | boolean            | Shadows from lights with `castShadow`, and a ground shadow |
| `lights`         | array of at most 8 | The lights below                                           |

| Light field  | Value                    | Meaning                                                              |
| ------------ | ------------------------ | -------------------------------------------------------------------- |
| `id`         | string                   | Unique within `lights`                                               |
| `name`       | string                   | Shown in the lighting panel                                          |
| `kind`       | `directional` or `point` |                                                                      |
| `color`      | `#rrggbb`                |                                                                      |
| `intensity`  | 0 to 10                  |                                                                      |
| `position`   | three numbers            | Where a directional light shines from, or where a point light is     |
| `range`      | 0 to 1,000,000 mm        | Point lights fade out by this distance. 0 reaches everything         |
| `castShadow` | boolean                  | Directional lights only, and only with `shadows` on and `camera` off |
| `enabled`    | boolean                  | Off keeps the light without drawing it                               |
| `camera`     | boolean                  | Moves with the camera, like a headlight                              |

A directional light's `position` is an offset from the center of the visible parts toward the
light. Only its direction counts, so it cannot be zero. A point light's `position` is a world
position in millimeters; it does not dim with distance unless it has a `range`. With `camera`,
both are in the camera's frame instead: x right, y up, +z toward the viewer.

## Validation

A file can be damaged, or crafted, so the reader checks it before trusting it:

- The header, plus `bodyLength`, must add up to exactly the file size. A partial download
  reports that the file is incomplete rather than failing somewhere later.
- Sections must lie inside the body, in order, without overlapping, and with the length
  implied by `vertices`. Total reads therefore cannot exceed the file size.
- Before any mesh memory is read, every layout is validated. Mesh values are then checked
  for non-finite numbers and out-of-range indices, the same as JSON scenes.
- Parts, joints, and plane constraints go through the same validation as JSON scenes.
- Editor colors and lighting are repaired rather than refused, since they never affect the
  geometry. A `lighting` that is not an object is ignored. Numbers are clamped into range, and
  a setting of the wrong type takes the Studio preset's value. A light is dropped when its `id`
  is missing or repeated, its `kind` is unknown, its `position` is not three finite numbers, or
  it is directional with a zero position, and only the first 8 valid lights are kept. Its other
  fields fall back to the name `Light` or `Point`, `#ffffff`, intensity 1, range 0, enabled,
  without shadows, and not following the camera. Unknown fields are dropped.
- A file with a higher version number asks for a newer version of Kitbasher.

## Autosave

Autosave uses the same section layout in IndexedDB, in two object stores:

- `geometries` holds one record per mesh: its layout and a `Blob` of its sections.
- `scenes` holds a `current` record with the header's metadata, where each part's
  `geometry` is a key in `geometries`.

Meshes never change once they are in a scene, so each is written once. After that, an
edit only rewrites the `current` record, however large the scene is. Publishing `current`
and deleting unused meshes happen in one transaction, so `current` always refers to meshes
that exist. If that transaction finds a mesh missing, because another window sharing the
save removed it, the write is retried. A failed write removes any partial meshes, keeps the
previous save, and shows "Recovery unavailable" in the status bar.

Autosaves from earlier versions hold their meshes inside the `current` record. They are
read once and replaced on the next save.

## Browser limits

These were measured in Chrome and shaped the implementation:

- A single `Blob` part of 2.2 GiB is rejected, and reading 2.2 GiB in one call fails.
  Sections are therefore written and read in 64 MiB chunks.
- A `Blob` the browser cannot hold is still created and only fails when used. IndexedDB
  can accept one without error, and a download would produce a broken file. Blobs are
  therefore read back before use, and a failure is reported instead.
- Private windows cannot page blobs to disk. They failed from about 1.5 GiB when other
  blobs were already held, and at 2.2 GiB otherwise.
- For about the first 2 seconds after the browser starts, blobs above roughly 256 MiB can
  fail. Saving reports an error, and trying again a moment later works.

Saving used free disk space of about twice the scene's size while the file was prepared
and downloaded. Autosave keeps one more copy of the scene's meshes. Beyond disk space, the
practical limit is device memory, because every mesh is held in memory while the scene is
open. These limits were not measured in Firefox or Safari.
