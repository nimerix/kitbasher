# Scene file format

`.kitbash` files store an assembly as a small JSON header followed by packed mesh data.
Text cannot hold large scenes: a single JavaScript string tops out near 512 MB, and one
5-million-triangle scan needs more than that as JSON.

Packing a mesh stores values that repeat once, then compresses what that leaves. An assembly
of STL parts with 7.7 million triangles takes 55 MB this way, where its values written out one
by one took 832 MB. Values that do not repeat are written as they are, so a mesh with nothing
repeated takes the space and the time it did before.

New files are always written in this format, version 3. Files from earlier versions still
open: version 2 holds the same header with every mesh value uncompressed, and version 1 is JSON.

## Layout

All integers and mesh data are little-endian.

| Offset | Size | Contents                                                    |
| ------ | ---- | ----------------------------------------------------------- |
| 0      | 8    | Magic: `KITBASH` followed by byte `0x1A`                    |
| 8      | 4    | Format version, `uint32`, currently `3`                     |
| 12     | 4    | Reserved, zero                                              |
| 16     | 8    | Header length in bytes, `uint64`                            |
| 24     | n    | Header: UTF-8 JSON, padded with spaces to a 4-byte boundary |
| 24 + n | m    | Body: one run of blocks per mesh                            |

The version in the prefix decides how the body is read. The header repeats it, and a file
whose two versions differ is refused.

### Header

Parts may include `pins`, an array of `{ id, point, target, kind, priority }`.
`point` is a finite mesh-local XYZ attachment; `target` is its finite world-space
resting position in millimeters. `kind` is `hard` or `soft`, and `priority` is a
finite number from 0 to 100. IDs are unique within each part. Hard targets remain
fixed during movement; soft targets provide weighted resistance. Pins are optional
editor metadata, independent of mesh buffers, supported by all three scene readers.

```jsonc
{
  "format": "kitbasher",
  "version": 3,
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
      // Where this mesh's blocks start, in bytes from the start of the body, and their total size.
      "offset": 0,
      "length": 1893,
      "vertices": 1200,
      // Each block is [values, bytes]. Here 204 distinct positions serve 1200 vertices.
      "positions": { "blocks": [[204, 1210]], "map": [[1200, 655]] },
      "colors": { "per": "mesh", "blocks": [[1, 28]] },
    },
  ],
  "bodyLength": 1893,
}
```

### Body

A mesh's blocks follow each other without gaps, in the order `positions.blocks`,
`positions.map`, `normals`, `colors`, `indices`. The header gives each block's size, so no
block carries an offset of its own, and blocks cannot overlap.

- With `positions.map`, `positions.blocks` holds the distinct positions and the map names the
  one each vertex uses. Both are compressed. A mesh from an STL repeats each position about
  six times, once for every triangle that meets there. The map is written when it leaves at
  most half as many positions. Without it, `positions.blocks` holds every vertex's position in
  order, as `float32` triples.
- `normals` and `colors` are stored as often as they change. With `"per": "face"` there is one
  for each triangle of a mesh without `indices`, and with `"mesh"` one for the whole mesh. Both
  are compressed. With `"vertex"` there is one for each vertex, as `float32` triples.
- `normals` is absent when the triangles alone give the same normals, as below.
- `indices` is `uint16` or `uint32`, as named by `type`, three per triangle. Without it,
  every three vertices form a triangle.
- A block is `[values, bytes]` and holds at most 2<sup>20</sup> triples or 3 × 2<sup>20</sup>
  indices. A block that is not compressed has 12 bytes for each triple, or 2 or 4 for each
  index. Compressed triples use [meshoptimizer](https://github.com/zeux/meshoptimizer)'s vertex
  codec, version 1, with 12 bytes per value. The map uses its index sequence codec with 4
  bytes per index.
- Parts that share a mesh, such as pasted copies, refer to the same `geometries` entry.
  The mesh is stored once and stays shared after reopening.

Only what repetition leaves behind is compressed. Compressing each vertex's own values and
the indices as well took a smooth 415 MB mesh to 150 MB, but its first save then took five
times as long, and it opened a third slower than uncompressed. Written as they are, they cost
what they did in version 2.

### What reopens exactly

Positions, colors, indices, and the order of vertices and triangles reopen bit for bit, down
to the sign of a zero. STL and 3MF exports are built from those alone, so a scene exports the
same bytes for printing before it is saved and after it is reopened.

Normals only change how a surface is lit. A mesh saved without them gets the ones three.js
computes: each triangle's own for a mesh without `indices`, and the area-weighted average
around each vertex for a mesh with them. Normals are left out when every one is within 0.001
of that computed normal, which is under 0.06 degrees, and a triangle without area is not
counted. Otherwise all of them are stored and reopen bit for bit. An STL's normals come from
the program that wrote it and differ from the computed ones by rounding, so they are left
out; smooth normals from a GLB are stored. GLB exports include normals, so they can differ by
that rounding after a scene is reopened.

### Packing once

Finding the repeats costs time that writing raw values did not: about 0.7 seconds for 7.7
million triangles on an M4 Max. Meshes never change once they are in a scene, so each is
packed once and the bytes are kept for every later save, including each Drive autosave. A
mesh opened from a file keeps that file's bytes, so saving an opened scene packs nothing and
writes back the same bytes. Packing gives way to the page every 50 ms, so the interface keeps
drawing while a large mesh is packed.

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
- Meshes must lie inside the body, in order, without overlapping, and each mesh's blocks must
  add up to its `length`. Total reads therefore cannot exceed the file size.
- Block counts must match `vertices`: one position for each vertex or a full map, and one
  normal or color for each vertex, each triangle, or the mesh. A packed file can be far smaller
  than the mesh it describes, so `vertices` is also held to what one mesh can draw, 2 GB per
  attribute.
- Before any mesh memory is read, every layout is validated, and a block that is not
  compressed must have exactly the bytes its values take. A compressed block that does not
  unpack to its count is refused. Mesh values are then checked for non-finite numbers, and the
  map and indices for values out of range, the same as JSON scenes.
- Parts, joints, and plane constraints go through the same validation as JSON scenes.
- Editor colors and lighting are repaired rather than refused, since they never affect the
  geometry. A `lighting` that is not an object is ignored. Numbers are clamped into range, and
  a setting of the wrong type takes the Studio preset's value. A light is dropped when its `id`
  is missing or repeated, its `kind` is unknown, its `position` is not three finite numbers, or
  it is directional with a zero position, and only the first 8 valid lights are kept. Its other
  fields fall back to the name `Light` or `Point`, `#ffffff`, intensity 1, range 0, enabled,
  without shadows, and not following the camera. Unknown fields are dropped.
- A file with a higher version number asks for a newer version of Kitbasher.

Blocks carry no checksum. Damage that still unpacks to finite values in range opens as a
different mesh, as it did in earlier versions.

## Version 2

Version 2 files have the same prefix and header, with `"version": 2` and these `geometries`:

```jsonc
{
  "vertices": 1200,
  // Offsets are bytes from the start of the body.
  "positions": { "offset": 0, "length": 14400 },
  "normals": { "offset": 14400, "length": 14400 },
  "colors": { "offset": 28800, "length": 14400 },
  "indices": { "offset": 43200, "length": 3600, "type": "u16" },
}
```

- `positions`, `normals`, and `colors` are uncompressed `float32` triples, 12 bytes per
  vertex. Only `positions` is required; normals are computed when absent.
- `indices` is `uint16` or `uint32`, three per triangle.
- Each section starts on a 4-byte boundary and is padded with zeros to the next one.
- Sections must lie inside the body, in order, without overlapping, and with the length
  implied by `vertices`.

Autosave and shared sessions still pass meshes as these sections. They stay on one computer
or one network, where the bytes cost little and packing them would cost time.

## Autosave

Autosave uses version 2's section layout in IndexedDB, in two object stores:

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
  Sections and packed meshes are therefore written and read in 64 MiB chunks.
- A `Blob` the browser cannot hold is still created and only fails when used. IndexedDB
  can accept one without error, and a download would produce a broken file. Blobs are
  therefore read back before use, and a failure is reported instead.
- Private windows cannot page blobs to disk. They failed from about 1.5 GiB when other
  blobs were already held, and at 2.2 GiB otherwise.
- For about the first 2 seconds after the browser starts, blobs above roughly 256 MiB can
  fail. Saving reports an error, and trying again a moment later works.

Saving used free disk space of about twice the file's size while the file was prepared
and downloaded. Autosave keeps one uncompressed copy of the scene's meshes. Beyond disk space,
the practical limit is device memory, because every mesh is held in memory while the scene is
open, along with the packed bytes of each mesh that has been saved or opened. These limits
were measured on uncompressed files, and not in Firefox or Safari.
