import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { viewDirections } from '../src/core/navigation';
import type { ViewName } from '../src/core/navigation';
import type { Vec3 } from '../src/core/types';
import { LiveView, openInBrowser } from './live';
import { renderScene } from './render';
import { Session, faces, requirePart } from './session';
import type { DuplicateSpec, PartSpec, PartUpdate, Placement, PointRef } from './session';
import { shapeTypes } from './shapes';

export const instructions = `Kitbasher builds multipart 3D assemblies as real mesh parts.

Conventions: units are millimeters. Y is up and the space is right-handed. The ground is y = 0. The front view looks from +Z, right from +X, top from +Y. Rotations are XYZ Euler degrees. Round shapes (cylinder, cone, lathe, capsule, torus) have their axis along Y.

Working well:
1. Build in real-world sizes, with one part per physical piece so it stays movable. add_parts takes many parts in one call, and one part can merge several shapes.
2. Use place_parts to stack or seat parts by their actual bounds rather than computing coordinates by hand. duplicate_parts makes mirrors and arrays.
3. Look at the result: call render_view after each stage. Coordinates that seem right can still look wrong. Then call inspect_interference, which reports overlaps, gaps, and parts floating free of everything else.
4. Use create_joint for parts that pivot and create_plane_constraint for relationships that must survive later moves. Joints, plane constraints, and locks stay in force through every later move, so a result marked constrained did not reach the requested pose.
5. Nothing is written to disk until save_scene or export_scene. Every tool call is one undo step, and a call that fails changes nothing. open_live_view shows the scene in the real Kitbasher app as it changes.`;

const vector = (description: string) => z.array(z.number()).length(3).describe(description);
const ids = (description: string) => z.array(z.string()).describe(description);

const pointRef = z
  .strictObject({
    face: z
      .enum(faces)
      .optional()
      .describe("Center of that side of the part's bounding box. Sets the normal too."),
    local: vector('Part-local millimeters.').optional(),
    world: vector('World millimeters.').optional(),
    normal: vector("In the point's space. Defaults to the nearest surface.").optional(),
  })
  .describe('A point on a part: exactly one of face, local, or world.');

const shape = z.strictObject({
  type: z
    .enum(shapeTypes)
    .describe(
      'box: size, corner_radius. cylinder: radius (or radius_top and radius_bottom), height. cone: radius, height. sphere: radius. capsule: radius, height (overall). torus: radius, tube. lathe: profile. extrude: outline, depth, holes, bevel. tube: path, radius, closed. loft: sections. mesh: positions, indices, colors.',
    ),
  size: z.array(z.number()).optional().describe('box: [x, y, z].'),
  corner_radius: z.number().optional().describe('box: rounded edge radius.'),
  radius: z.number().optional(),
  radius_top: z.number().optional().describe('cylinder: 0 makes a point.'),
  radius_bottom: z.number().optional(),
  height: z.number().optional(),
  tube: z.number().optional().describe('torus: thickness radius of the ring.'),
  segments: z.number().int().optional().describe('Facets around a round shape. Default 32 to 48.'),
  profile: z
    .array(z.array(z.number()))
    .optional()
    .describe('lathe: [radius, y] points revolved around Y. Open ends close at the axis.'),
  outline: z
    .array(z.array(z.number()))
    .optional()
    .describe('extrude: closed [x, y] polygon, extruded along Z and centered on z = 0.'),
  holes: z
    .array(z.array(z.array(z.number())))
    .optional()
    .describe('extrude: [x, y] hole polygons.'),
  depth: z.number().optional().describe('extrude: overall length along Z.'),
  bevel: z.number().optional().describe('extrude: edge chamfer size.'),
  path: z.array(z.array(z.number())).optional().describe('tube: [x, y, z] points, smoothed.'),
  closed: z.boolean().optional().describe('tube: join the ends into a loop.'),
  sections: z
    .array(
      z.strictObject({
        y: z.number(),
        radius: z.number().optional(),
        size: z.array(z.number()).optional().describe('Rectangle [x, z].'),
        outline: z.array(z.array(z.number())).optional().describe('Polygon of [x, z] points.'),
        center: z.array(z.number()).optional().describe('[x, z] offset.'),
      }),
    )
    .optional()
    .describe('loft: cross sections blended along Y, each with radius, size, or outline.'),
  positions: z.array(z.number()).optional().describe('mesh: flat x, y, z list.'),
  indices: z.array(z.number()).optional().describe('mesh: three per triangle, counter-clockwise.'),
  colors: z.array(z.number()).optional().describe('mesh: flat linear r, g, b list, 0 to 1.'),
  position: vector("Offset within the part's local space.").optional(),
  rotation: vector('XYZ Euler degrees, around the shape center.').optional(),
  scale: vector('Per-axis scale, for example to make an ellipsoid.').optional(),
  color: z.string().optional().describe('#rrggbb or a CSS name, for mixed-color parts.'),
  smooth_angle: z
    .number()
    .optional()
    .describe('Edges sharper than this many degrees stay creased. Default 35.'),
});

const part = z.strictObject({
  id: z.string().optional().describe('Short id. Defaults to one made from the name.'),
  name: z.string(),
  shapes: z.array(shape).min(1).describe('Merged into one mesh, in the part local space.'),
  position: vector("World position of the part's local origin. Default [0, 0, 0].").optional(),
  rotation: vector('XYZ Euler degrees, around the local origin.').optional(),
  scale: vector('Per-axis scale.').optional(),
  color: z.string().optional().describe('#rrggbb or a CSS name.'),
  locked: z.boolean().optional(),
  visible: z.boolean().optional(),
});

const update = z.strictObject({
  id: z.string(),
  name: z.string().optional(),
  color: z.string().optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  pivot: z
    .array(z.number())
    .length(3)
    .nullable()
    .optional()
    .describe('Local rotation and scale pivot. null resets to the mesh center.'),
  position: vector("World position of the part's local origin.").optional(),
  translate: vector('Move by this world offset.').optional(),
  rotation: vector('Absolute XYZ Euler degrees, around the pivot.').optional(),
  quaternion: z.array(z.number()).length(4).optional().describe('Absolute [x, y, z, w].'),
  rotate_by: z
    .strictObject({
      axis: vector('World axis.'),
      degrees: z.number(),
      about: vector('World point to rotate around. Defaults to the pivot.').optional(),
    })
    .optional()
    .describe('Turn by an amount from the current pose.'),
  scale: vector('Absolute per-axis scale, around the pivot. A negative value mirrors.').optional(),
});

const sideOptions = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;
const alignMode = z.enum(['center', 'min', 'max', 'keep']).optional();

const patch = z.strictObject({
  part: z.string().optional().describe('Needed only for flush seams against several neighbors.'),
  point: vector('World point on or near the surface.'),
  radius: z.number().positive().describe('Patch radius in millimeters.'),
  plane_angle: z.number().optional().describe('Only keep faces within this angle of the seed.'),
  plane_distance: z.number().optional().describe('Only keep faces this close to the seed plane.'),
});

const planeKinds = ['mate', 'parallel', 'perpendicular', 'angle'] as const;

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const edits = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const replaces = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

export function createServer(session = new Session(), live = new LiveView()) {
  const server = new McpServer({ name: 'kitbasher', version: '1.0.0' }, { instructions });

  // A client can send calls in parallel, but each one must see the previous call's finished scene.
  let queue: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(run: () => Promise<T> | T) => {
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  };

  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    annotations: typeof readOnly,
    input: Shape,
    run: (args: z.infer<z.ZodObject<Shape>>) => unknown | Promise<unknown>,
  ) =>
    server.registerTool(name, { description, annotations, inputSchema: z.strictObject(input) }, ((
      args: z.infer<z.ZodObject<Shape>>,
    ) =>
      inOrder(async () => {
        try {
          const result = await run(args);
          return (result as CallToolResult)?.content ? result : json(result);
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: (error as Error).message }],
          };
        }
      })) as never);

  tool(
    'get_scene',
    'Lists the scene: parts with exact world bounds and sizes, joints, plane constraints, and residuals.',
    readOnly,
    {
      ids: ids('Only these parts.').optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(1000).optional().describe('Default 200.'),
    },
    ({ ids: only, offset, limit }) => session.summary(only, offset, limit),
  );

  tool(
    'new_scene',
    'Starts an empty scene, or the Scout sample robot. Refuses to drop unsaved work unless told to.',
    replaces,
    {
      name: z.string().optional(),
      sample: z.boolean().optional().describe('Load the 15-part Scout sample.'),
      discard_unsaved: z.boolean().optional(),
    },
    ({ name, sample, discard_unsaved }) => session.newScene(name, sample, discard_unsaved),
  );

  tool(
    'open_scene',
    'Replaces the scene with a .kitbash file. Refuses to drop unsaved work unless told to.',
    replaces,
    { path: z.string(), discard_unsaved: z.boolean().optional() },
    ({ path, discard_unsaved }) => session.openScene(path, discard_unsaved),
  );

  tool(
    'save_scene',
    'Writes the complete editable scene to a .kitbash file, which opens in the Kitbasher app.',
    edits,
    {
      path: z.string().optional().describe('Defaults to the file this scene last used.'),
      overwrite: z.boolean().optional().describe('Replace a different existing file.'),
    },
    ({ path, overwrite }) => session.saveScene(path, overwrite),
  );

  tool(
    'export_scene',
    'Exports by file extension: .glb (named parts and colors), .stl (one mesh, Z up, for printing), .3mf (separate objects), or .zip (a Blender package that rebuilds joints).',
    edits,
    {
      path: z.string(),
      ids: ids('Only these parts. Defaults to all.').optional(),
      overwrite: z.boolean().optional(),
    },
    ({ path, ids: only, overwrite }) => session.exportScene(path, only, overwrite),
  );

  tool(
    'add_parts',
    'Adds parts built from shapes, in one undo step. Prefer sending every part of a stage in one call. Shapes are centered on their local origin unless offset with position. Returns each part with its exact bounds.',
    edits,
    { parts: z.array(part).min(1) },
    ({ parts }) => session.addParts(parts as PartSpec[]),
  );

  tool(
    'import_model',
    'Adds the meshes of an STL, OBJ, GLB, embedded GLTF, or 3MF file as parts. Automatic units are meters and Y up for glTF, millimeters and Z up for STL and OBJ, and the declared unit and Z up for 3MF.',
    edits,
    {
      path: z.string(),
      units: z.enum(['auto', 'mm', 'cm', 'm', 'in']).optional(),
      up: z.enum(['auto', 'y', 'z']).optional(),
      center: z.boolean().optional().describe('Center on the origin and rest on the ground.'),
    },
    ({ path, ...options }) => session.importModel(path, options),
  );

  tool(
    'update_parts',
    'Moves, turns, scales, renames, recolors, hides, or locks parts in one undo step. Joints and plane constraints still apply: a result marked constrained did not reach the requested pose. Set position or translate, and rotation, quaternion, or rotate_by.',
    edits,
    { updates: z.array(update).min(1) },
    ({ updates }) => session.updateParts(updates as PartUpdate[]),
  );

  tool(
    'place_parts',
    "Seats parts by their exact world bounds instead of coordinates. side is the side of the target to sit against, so side '+y' rests a part on top of it. The other axes follow align, centering on the target by default. With no target, the part rests on the ground plane and keeps its x and z.",
    edits,
    {
      placements: z
        .array(
          z.strictObject({
            id: z.string(),
            target: z.string().optional().describe("Part id, or 'ground' (the default)."),
            side: z.enum(sideOptions).optional().describe("Default '+y' on the ground."),
            gap: z.number().optional().describe('Distance from that side. Negative embeds.'),
            align: z
              .strictObject({ x: alignMode, y: alignMode, z: alignMode })
              .optional()
              .describe('center, min or max (flush with that side of the target), or keep.'),
            offset: vector('Extra world offset applied last.').optional(),
          }),
        )
        .min(1),
    },
    ({ placements }) => session.placeParts(placements as Placement[]),
  );

  tool(
    'duplicate_parts',
    'Copies parts, sharing their meshes. translate and rotate apply once per copy, making linear and radial arrays. mirror reflects across a world plane. Joints and constraints among the copied parts are copied too.',
    edits,
    {
      ids: ids('Parts to copy together.'),
      count: z.number().int().optional().describe('Number of copies. Default 1.'),
      translate: vector('World offset between copies.').optional(),
      rotate: z
        .strictObject({
          axis: vector('World axis.'),
          degrees: z.number().describe('Turn between copies.'),
          about: vector('World point. Default origin.').optional(),
        })
        .optional(),
      mirror: z
        .strictObject({
          axis: z.enum(['x', 'y', 'z']),
          at: z.number().optional().describe('Plane position on that axis. Default 0.'),
        })
        .optional(),
      names: z.array(z.string()).optional().describe('Names for the new parts, in order.'),
    },
    (args) => session.duplicateParts(args as DuplicateSpec),
  );

  tool(
    'delete_parts',
    'Deletes parts, and any joints and plane constraints that use them.',
    replaces,
    { ids: ids('Parts to delete.') },
    ({ ids: list }) => session.deleteParts(list),
  );

  tool(
    'merge_parts',
    'Replaces parts with one mesh. combine keeps every triangle and works on anything. union, subtract (the first part minus the rest), and intersect are solid Booleans: they need closed, non-self-intersecting meshes, so union a part built from overlapping shapes before subtracting from it. Joints and constraints on the inputs are removed.',
    replaces,
    {
      ids: ids('At least two parts. For subtract, the first is kept and the rest cut it.'),
      mode: z.enum(['combine', 'union', 'subtract', 'intersect']),
      name: z.string().optional(),
      keep_originals: z
        .boolean()
        .optional()
        .describe('Add the result without removing the inputs.'),
    },
    ({ ids: list, mode, name, keep_originals }) =>
      session.mergeParts(list, mode, name, keep_originals),
  );

  tool(
    'align_parts',
    'Moves the source part rigidly onto the target and returns the residual. point: match one point. point_to_plane: slide along the target normal only. plane: face two surfaces and seat them, with offset along the target normal. points: best fit through three or more non-collinear pairs. The target can be a part or a reference plane: plane-xz, plane-xy, plane-yz.',
    edits,
    {
      source: z.string().describe('The part that moves.'),
      target: z.string().describe('Stays fixed.'),
      method: z.enum(['point', 'point_to_plane', 'plane', 'points']),
      pairs: z.array(z.strictObject({ source: pointRef, target: pointRef })).min(1),
      offset: z.number().optional(),
      opposed: z.boolean().optional().describe('plane: normals face each other. Default true.'),
    },
    (args) =>
      session.alignParts(
        args as Parameters<Session['alignParts']>[0] & {
          pairs: { source: PointRef; target: PointRef }[];
        },
      ),
  );

  tool(
    'fit_surfaces',
    'Fits a part using surface patches, each the connected mesh around a point. Suited to imported scans. contact: refine onto matching surfaces, with at least three pairs. flush: level the part with neighbors across seams, with one pair per seam on outward-facing surfaces. mate, parallel, perpendicular, angle: fit a plane to each patch and apply the relationship; keep_constraint retains it through later moves.',
    edits,
    {
      source: z.string().describe('The part that moves.'),
      target: z.string().optional().describe('Stays fixed. Flush pairs can name their own part.'),
      method: z.enum(['contact', 'flush', ...planeKinds]),
      pairs: z.array(z.strictObject({ source: patch, target: patch })).min(1),
      offset: z.number().optional().describe('Signed distance between surfaces in millimeters.'),
      angle: z.number().optional().describe('angle: degrees between normals, 0 to 180.'),
      opposed: z.boolean().optional().describe('Normals face each other. Default true.'),
      keep_constraint: z.boolean().optional(),
    },
    (args) => session.fitSurfaces(args as Parameters<Session['fitSurfaces']>[0]),
  );

  tool(
    'fit_anchors',
    'Fits a part so points on it land as close as possible to world targets, without scaling. Works with any number of anchors, and leaves gaps rather than stretching when they conflict. Replaces the anchors the part already has, and they are saved with it.',
    edits,
    {
      part: z.string(),
      anchors: z.array(z.strictObject({ point: pointRef, target: vector('World target.') })).min(1),
    },
    ({ part: id, anchors }) => session.fitAnchors(id, anchors as never),
  );

  tool(
    'create_joint',
    'Connects a child to a parent at matching anchors and seats the child there. The child then rotates around its anchor and moves with its parent. A part has one parent, and cycles are refused.',
    edits,
    {
      child: z.string(),
      parent: z.string(),
      child_anchor: pointRef,
      parent_anchor: pointRef,
      rotation_locks: z
        .array(z.boolean())
        .length(3)
        .optional()
        .describe('Locked [x, y, z] rotation axes. Default [true, false, true], a hinge around Y.'),
      keep_connected: z.boolean().optional().describe('false seats it once, then leaves it free.'),
      name: z.string().optional(),
    },
    (args) => session.createJoint(args as Parameters<Session['createJoint']>[0]),
  );

  tool(
    'update_joint',
    'Changes a joint. Locking an axis captures the current pose, and turning keep_connected back on reseats the child.',
    edits,
    {
      id: z.string(),
      name: z.string().optional(),
      rotation_locks: z.array(z.boolean()).length(3).optional(),
      keep_connected: z.boolean().optional(),
    },
    ({ id, ...change }) => session.updateJoint(id, change),
  );

  tool(
    'create_plane_constraint',
    'Keeps a plane on the source related to a plane on the target through later moves. mate: seat the planes at a signed offset. parallel, perpendicular, angle: orient only. The target drives the source, so circular relationships are refused.',
    edits,
    {
      source: z.string().describe('The part that moves.'),
      target: z.string(),
      kind: z.enum(planeKinds),
      source_plane: pointRef,
      target_plane: pointRef,
      angle: z.number().optional().describe('angle: degrees between normals, 0 to 180.'),
      offset: z.number().optional().describe('mate: signed distance in millimeters.'),
      opposed: z
        .boolean()
        .optional()
        .describe('mate and parallel: normals face each other. Default true.'),
      name: z.string().optional(),
    },
    (args) =>
      session.createPlaneConstraint(args as Parameters<Session['createPlaneConstraint']>[0]),
  );

  tool(
    'update_plane_constraint',
    'Edits a plane constraint. enabled: false suppresses it so the part can move freely, and it stays available to turn back on.',
    edits,
    {
      id: z.string(),
      name: z.string().optional(),
      kind: z.enum(planeKinds).optional(),
      angle: z.number().optional(),
      offset: z.number().optional(),
      opposed: z.boolean().optional(),
      enabled: z.boolean().optional(),
    },
    ({ id, ...change }) => session.updatePlaneConstraint(id, change),
  );

  tool(
    'remove_relationships',
    'Removes joints and plane constraints. Parts stay where they are.',
    edits,
    {
      joints: ids('Joint ids.').optional(),
      plane_constraints: ids('Plane constraint ids.').optional(),
    },
    ({ joints, plane_constraints }) => session.removeRelationships(joints, plane_constraints),
  );

  tool(
    'undo',
    'Undoes the last scene change. The most recent 40 changes are kept.',
    edits,
    {},
    () => session.undo(),
  );

  tool('redo', 'Redoes the last undone change.', edits, {}, () => session.redo());

  tool(
    'raycast',
    'Fires a ray and returns surface hits with world and local points and normals, nearest first. Use these to find exact anchor positions on a mesh.',
    readOnly,
    {
      origin: vector('World start point.'),
      direction: vector('World direction.'),
      ids: ids('Only test these parts. Defaults to visible parts.').optional(),
      all: z.boolean().optional().describe('Return every hit rather than the nearest.'),
    },
    ({ origin, direction, ids: only, all }) => session.raycast(origin, direction, only, all),
  );

  tool(
    'inspect_interference',
    'Checks the assembled parts. Reports each pair that overlaps, touches, or comes within distance, with overlap volume, gap, and closest points. Also lists isolated parts, which are near nothing else and often a mistake.',
    readOnly,
    {
      ids: ids('Only compare these parts. Defaults to visible parts.').optional(),
      distance: z
        .number()
        .min(0)
        .optional()
        .describe('Report pairs within this gap. Default 0.5 mm.'),
    },
    ({ ids: only, distance }) => session.inspect(only, distance ?? 0.5),
  );

  tool(
    'render_view',
    'Renders the scene to a PNG so you can see it. Defaults to a four-view sheet: isometric, front, right, and top. Views are orthographic, with an axis triad, a true scale bar, and a ground grid at y = 0.',
    {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    {
      views: z
        .array(z.enum(Object.keys(viewDirections) as [ViewName, ...ViewName[]]))
        .min(1)
        .max(9)
        .optional(),
      direction: vector('A custom view, from the target toward the camera.').optional(),
      parts: ids('Only draw these parts. Defaults to visible parts.').optional(),
      frame: ids('Zoom to fit these parts, while still drawing the others.').optional(),
      highlight: ids('Tint these parts orange and gray out the rest.').optional(),
      labels: z.boolean().optional().describe('Write part ids over the image.'),
      grid: z.boolean().optional().describe('Draw the ground grid. Default true.'),
      width: z.number().int().min(128).max(2048).optional().describe('Default 1024.'),
      height: z.number().int().min(128).max(2048).optional(),
      output_path: z.string().optional().describe('Also write the PNG to this path.'),
    },
    async ({ parts, frame, output_path, views, direction, ...options }) => {
      const drawn = session.renderableParts(parts);
      const rendered = renderScene(drawn, {
        ...options,
        views,
        direction: direction as Vec3 | undefined,
        frame: frame?.map((id) => requirePart(id)),
      });
      let saved: string | undefined;
      if (output_path) {
        saved = resolve(output_path);
        if (extname(saved).toLowerCase() !== '.png')
          throw new Error('output_path must end in .png.');
        await mkdir(dirname(saved), { recursive: true });
        await writeFile(saved, rendered.png);
      }
      return {
        content: [
          {
            type: 'image',
            data: Buffer.from(rendered.png).toString('base64'),
            mimeType: 'image/png',
          },
          {
            type: 'text',
            text: JSON.stringify({
              views: rendered.views,
              parts: drawn.length,
              triangles: rendered.triangles,
              ...(rendered.grid_mm ? { grid_mm: rendered.grid_mm } : {}),
              ...(saved ? { path: saved } : {}),
            }),
          },
        ],
      } satisfies CallToolResult;
    },
  );

  tool(
    'open_live_view',
    'Opens the scene in the real Kitbasher app in a browser tab, which follows every change as it is made. Use it when the user wants to watch. The tab can inspect and save, but its own edits are replaced by the next change here. It needs the app to be built with npm run build.',
    edits,
    { open_browser: z.boolean().optional().describe('Default true. false only returns the URL.') },
    async ({ open_browser }) => {
      const url = await live.start();
      const opened = open_browser === false ? false : openInBrowser(url);
      return { url, opened, viewers: live.viewers };
    },
  );

  return { server, session, live };
}
