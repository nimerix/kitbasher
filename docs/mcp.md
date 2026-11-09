# Building with agents (MCP)

Kitbasher includes a [Model Context Protocol](https://modelcontextprotocol.io) server, so
coding agents such as Claude Code and Codex can build, assemble, check, and export models
directly. It needs no browser or GPU, and it runs the same scene store, joint and constraint
solvers, and file formats as the app. A `.kitbash` file an agent saves opens in the app, ready to
keep editing.

The server runs on your machine and connects to nothing except a local address, and only if you
use the live view. Your agent's own client sends tool results, including rendered images and part
data, to its model provider.

## Set up

Requires Node.js 22.12 or newer. Build once, and again after updating Kitbasher:

```sh
npm install
npm run build
```

This produces one self-contained file, `dist-mcp/kitbasher-mcp.js`. Use its absolute path below.

**Claude Code**

```sh
claude mcp add --scope user kitbasher -- node /absolute/path/to/kitbasher/dist-mcp/kitbasher-mcp.js
```

**Codex**

```sh
codex mcp add kitbasher -- node /absolute/path/to/kitbasher/dist-mcp/kitbasher-mcp.js
```

To let Codex use the tools without asking each time, including in `codex exec`, add this to
`~/.codex/config.toml`:

```toml
[mcp_servers.kitbasher]
command = "node"
args = ["/absolute/path/to/kitbasher/dist-mcp/kitbasher-mcp.js"]
default_tools_approval_mode = "approve"
```

**Other clients** that support stdio servers use the same command and argument.

Then ask for something:

> Build a desk lamp with a weighted base, two jointed arms, and a conical shade. Check that it is
> properly connected, and save it as lamp.kitbash.

## Conventions

- Units are millimeters. Y is up and the space is right-handed. The ground is y = 0.
- The front view looks from +Z, right from +X, and top from +Y, the same as the app.
- Rotations are XYZ Euler degrees. Round shapes have their axis along Y.
- A part's position is where its local origin sits in the world. Its shapes keep the local
  coordinates they were written in, so joint anchors can use those same numbers.

The server gives connecting agents these conventions, along with a suggested way of working.

## Tools

| Tool                                                 | Purpose                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `add_parts`                                          | Add parts built from box, cylinder, cone, sphere, capsule, torus, lathe, extrude, tube, loft, and raw mesh shapes             |
| `import_model`                                       | Add the meshes of an STL, OBJ, GLB, embedded GLTF, or 3MF file                                                                |
| `update_parts`                                       | Move, turn, scale, rename, recolor, hide, or lock parts                                                                       |
| `place_parts`                                        | Seat parts against each other or the ground by their exact bounds                                                             |
| `duplicate_parts`                                    | Copy parts as linear arrays, radial arrays, or mirrors, sharing their meshes                                                  |
| `delete_parts`                                       | Delete parts and their relationships                                                                                          |
| `merge_parts`                                        | Combine meshes, or make a Boolean union, subtraction, or intersection                                                         |
| `align_parts`                                        | Point to point, point to plane, plane to plane, and best fit through three or more point pairs                                |
| `fit_surfaces`                                       | Contact fit, flush fit across seams, and plane relationships, from patches of a mesh around a point. Suited to imported scans |
| `fit_anchors`                                        | Best-fit a part so points on it reach world targets, leaving gaps rather than stretching                                      |
| `create_joint`, `update_joint`                       | Connect a child to a parent at anchors, with locked rotation axes                                                             |
| `create_plane_constraint`, `update_plane_constraint` | Keep a mate, parallel, perpendicular, or angle relationship through later moves                                               |
| `remove_relationships`                               | Remove joints and plane constraints, leaving parts in place                                                                   |
| `render_view`                                        | Return a PNG so the agent can see its work                                                                                    |
| `inspect_interference`                               | Report overlaps with their volume, contacts, gaps, and parts floating free of everything else                                 |
| `raycast`                                            | Find exact surface points and normals                                                                                         |
| `get_scene`                                          | List parts with exact bounds, joints, constraints, and residuals                                                              |
| `new_scene`, `open_scene`, `save_scene`              | Start, open, and save `.kitbash` scenes                                                                                       |
| `export_scene`                                       | Write GLB, STL, 3MF, or a Blender package, chosen by file extension                                                           |
| `undo`, `redo`                                       | Step through the most recent 40 changes                                                                                       |
| `open_live_view`                                     | Show the scene in the real app as it changes                                                                                  |

## Behavior

**Each call is all or nothing.** A call that changes the scene is one undo step. If any part of it
fails, including a later item in a batch, nothing changes and the error says why. A client can send
calls in parallel; they run in the order they were sent.

**Relationships stay in force.** Joints, plane constraints, and locks hold through every later move,
as they do in the app. A result marked `constrained` did not reach the requested pose.

**Nothing is written until asked.** The scene lives in the server's memory and ends with the session,
so agents should call `save_scene`. Saves and exports will not replace another existing file without
`overwrite: true`, and they write through a temporary file, so a failure leaves any existing file
intact. `new_scene` and `open_scene` will not drop unsaved work without `discard_unsaved: true`.

**File access is by type.** Tools read only scene and model files, and write only `.kitbash`, `.glb`,
`.stl`, `.3mf`, `.zip`, and `.png`. Relative paths start from the folder your client runs the server
in. There is no folder restriction beyond what your client's permissions apply.

## Seeing the model

`render_view` draws on the CPU, so it works anywhere, including in sandboxes and on machines with no
GPU. It defaults to a sheet of isometric, front, right, and top views. Views are orthographic and
carry an axis triad and a true scale bar, so proportions and misalignment can be judged directly.
Back faces are hidden, as in the app, so an inside-out mesh looks wrong here too. The renderer has
no shadows or materials: for a final look, use the app or export to Blender.

`open_live_view` serves the built app on a private local address and opens it in your browser. The
tab follows every change and keeps the model in view, until you move the camera yourself.

- It follows in one direction. You can orbit, select, inspect, and save a copy from the tab, but the
  agent's next change replaces any edits made there. To keep editing by hand, open a saved
  `.kitbash` file in the normal app.
- It keeps no local autosave, and does not touch the autosave of the normal app.
- If the agent's session ends, the tab keeps the last scene and says so. Use **Save scene** to keep it.

The address listens on 127.0.0.1 only, includes a random token, and ignores other host names.
Set `KITBASHER_LIVE_PORT` to use a fixed port.

## Limits

- **One scene per server.** Each client session starts its own server and its own scene.
- **Booleans run on the server's only thread.** To stay inside a client's tool timeout, they are limited
  to 2 million triangles in total, rather than the app's 10 million per part. Other tool calls wait while
  one runs.
- **Booleans need closed meshes that do not intersect themselves.** Every shape except a raw `mesh` is
  closed. A part built from overlapping shapes is not a clean solid: build those shapes as separate parts
  and union them before cutting.
- **Scene size is limited by the memory given to Node,** rather than by a browser. Saving briefly holds a
  second copy of the scene.
- Everything in [Scope and limitations](../README.md#scope-and-limitations) also applies, including
  the loss of texture maps on import.

## Source

| File             | Contents                                                                     |
| ---------------- | ---------------------------------------------------------------------------- |
| `mcp/server.ts`  | Stdio entry point                                                            |
| `mcp/tools.ts`   | Tool definitions, their schemas, and the instructions given to agents        |
| `mcp/session.ts` | The operations, built on the app's store and solvers                         |
| `mcp/shapes.ts`  | Shape builders, which all produce closed solids                              |
| `mcp/render.ts`  | The CPU renderer and PNG encoder                                             |
| `mcp/live.ts`    | The local server behind the live view. `src/core/live.ts` is the page's side |
| `mcp/measure.ts` | Exact world bounds and closest-surface lookups                               |
| `mcp/shims.ts`   | The browser APIs Three's loaders and exporters expect                        |
