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
  "parts": [{ "id": "torso", "name": "Torso shell", "geometry": 0 /* … */ }],
  "joints": [],
  "constraints": [],
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

## Validation

A file can be damaged, or crafted, so the reader checks it before trusting it:

- The header, plus `bodyLength`, must add up to exactly the file size. A partial download
  reports that the file is incomplete rather than failing somewhere later.
- Sections must lie inside the body, in order, without overlapping, and with the length
  implied by `vertices`. Total reads therefore cannot exceed the file size.
- Before any mesh memory is read, every layout is validated. Mesh values are then checked
  for non-finite numbers and out-of-range indices, the same as JSON scenes.
- Parts, joints, and plane constraints go through the same validation as JSON scenes.
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
