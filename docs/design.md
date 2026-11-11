# Kitbasher workbench

The product is a local-first, cross-platform browser editor, built with React,
TypeScript, Vite, and Three.js. All mesh editing and file processing runs locally.

## Visual specification

An understated dark CAD workbench with warm orange active states. A compact top
bar contains the brand, document name, save, and export. A second tool strip holds
selection, transforms, alignment, joints, and merging. A 248px parts sidebar and
288px inspector flank a generous, real WebGL viewport. A slim bottom status bar
shows contextual instructions. Avoid dashboard cards and marketing content.

Colors: background #181a1d, panels #202226, viewport #26292e, raised #2b2e33,
border #34373d, primary text #e9eaec, secondary text #959aa3, accent #ed9b54.
Typography: system sans, 12px editor chrome, 11px metadata, 18px brand; tabular
numbers in numeric inputs. Corners 5–8px; thin outline icons at 16px.

The sample is a multipart, original stylized expedition robot on a round base.
Each component is actual editable geometry. A subtle ground grid, studio
lighting, selection silhouette, axis gizmo, orientation cube, and focus control
provide spatial context. Lighting is adjustable per scene from a display menu at the
top of the viewport, with Studio as the default. Smaller screens use collapsible sidebars.

## Core behavior and acceptance

- Select and multiselect from the viewport and part tree; orbit, pan, zoom,
  focus, use orthographic views, and manipulate via numeric or gizmo transforms.
- Import STL, OBJ, GLB/GLTF, and 3MF meshes, preserving placement and units.
- Pick actual mesh surface points/normals for point-to-point, point-to-plane,
  plane-to-plane, or least-squares rigid alignment using three or more pairs.
- Create joints with a persistent Keep connected toggle and independently locked
  rotation axes. Active links keep anchors together during placement and alignment;
  paused links retain metadata and allow independent placement. Child translation
  can carry the connected assembly; fixed parts pin it. Rotation pivots at the
  surface anchor. Alignment targets remain stationary and the achieved residual
  includes any joint constraints.
- Keep move/rotate/scale gizmos on visible geometry even for legacy scans whose
  local origins are far away. Rebase new imports without changing world placement.
  Numeric rotation/scale and viewport tools use the same visible/anchor pivot.
- Hold Shift for incremental one-tenth gizmo sensitivity, including mid-drag
  changes. End interrupted drags cleanly so camera navigation always resumes.
- Paint only edge-connected mesh patches; optional fixed seed-plane angle and
  distance tolerances exclude adjacent bends and prevent plane drift across strokes.
- Fit painted planes with area-weighted moments. Offer mate with signed offset,
  parallel, perpendicular, and explicit normal-angle placement using 1+ pairs.
  Keep contact best fit available with 3+ pairs.
- Optionally retain plane relationships as directed CAD-style assembly constraints.
  Project transforms through compatible equations and existing joints; reject
  conflicts and cycles without modifying the scene. Preserve remaining freedom:
  mates allow planar slide/twist and angle relationships allow translation.
  The Constraints tab exposes names, parameters, residuals, suppression, and deletion.
  Save/recovery and internal clipboard relationships retain these definitions;
  Blender/GLB retain solved placement and plane metadata, with live solving in Kitbasher.
- Offer a persisted No clip toggle, on by default, with an adjustable overlap allowance in
  millimeters. Every move and fit treats other visible parts as solid: drags slide along
  surfaces and never tunnel, and typed values, alignments, and anchor fits land on the nearest
  clear placement. Joints, locks, and kept constraints win, and remaining overlap is reported.
  Existing overlap is kept by moves and never deepened. See [clipping](#avoiding-clipping).
- Isolate the selection with one key, as a view state that never edits, saves, or shares the
  scene. Optionally keep other parts drawn, and pickable, wherever they come within a set
  distance of the isolated parts, updating as parts move. See [isolation](#isolation).
- Show parts in their material colors, in per-part editor colors, or each in a distinct color,
  without changing what any export or merge contains. Adjust the scene's lighting with presets,
  brightness, and up to 8 directional or point lights, placed by handle or by numbers. Both are
  saved with the scene and undoable. See [editor colors and lighting](#editor-colors-and-lighting).
- Offer a headset view where the browser has WebXR. The model is set within reach at a scale
  the viewer chooses, parts are held by hand through the same joints, constraints, and No clip
  as a drag, one or two hands move and resize the world, and a small panel in the headset
  covers what the page's interface cannot. `npm run headset` shares one scene between a tab on
  the computer and a headset on the network. See [headset](#headset).
- Allow any number of matching pairs after the third, show pending pair state,
  per-pair removal, and preview RMS using the same solver used on application.
- Explicitly save and reopen a self-contained .kitbash scene, with IndexedDB
  recovery. Export separate meshes to Blender-compatible GLB and multipart 3MF.
- Combine selected geometry or perform a true Boolean union in a worker. Both
  operations are undoable; failure leaves the scene untouched.
- Verify alignment math, constraint propagation, scene round trips, file export,
  build, and interactions with local Playwright. Preview tools are restricted
  to explicitly requested browser work, so use shell-run Playwright for QA.

Image generation tools are unavailable in this session. The visual specification
is code-native; there is no generated concept image. The rendered robot must
remain actual 3D geometry rather than a background image.

## Avoiding clipping

`src/core/clipping.ts` places parts as near a requested pose as other parts allow. Surface
samples of each part are measured against the other's mesh in both directions. Each contact
is a plane the moving part must stay in front of, less the allowance, and the smallest
correcting step is solved from those planes. A sample near an edge may pass it on either
side, so its plane is chosen from where the step takes it. A gesture marches from the
current pose in short steps and only accepts placements measured clear, which is what stops
tunnelling. A fit starts at its target and steps out. Corrections shift a part for moves and
plane methods, and may also turn it for best fits. The solver calls the same joint and
constraint pipeline as an unobstructed move, so those relationships hold throughout.

## Isolation

The isolated set lives beside the selection in the editor store, outside the scene document,
so undo, autosave, scene files, and shared sessions never see it. It changes what the
viewport draws and picks, what Frame all frames, and what the interference view compares.
Clipping, joints, constraints, and exports keep using part visibility. Parts that leave the
scene leave the set, and parts made or restored while isolating join it. I starts a plain
isolation and Shift + I one with nearby surfaces, so each key always does the same thing.
Gizmos and markers follow what is drawn, including parts too far away to appear.

Nearby surfaces need the distance from every drawn fragment of the other parts to the
isolated parts, each frame, on meshes of any density. `src/core/proximity.ts` measures that
once into a grid around the isolated parts: surface samples are written to the grid nodes
beside them, and eight sweeps carry each node the nearest sample its neighbors know. Vertices
are the samples, with larger triangles sampled across their face, so the cost follows the
vertex count and the grid size, not their product. The result is one byte per node in a 3D
texture. A shader on the other parts looks it up and discards fragments beyond the distance,
and picking reads the same bytes, so a click lands exactly where something is drawn.

The grid sits in the frame of the first isolated part, without its scale. Moving that part,
or all isolated parts together, only changes the matrix into the grid, which is why the cut
tracks a drag at no cost. Between nodes a surface in contact reads up to three quarters of a
cell away, so the drawing limit never goes below that. The work is cut into slices of a few
milliseconds on the main thread, which reads the mesh in place instead of copying a dense
scan to a worker.

## Editor colors and lighting

A part's `color` is its material color, which every export and merge reads. `displayColor` is
an optional editor color that only the viewport reads. `shownColor` in `src/core/appearance.ts`
decides what is drawn: Material shows material and vertex colors, Editor shows the editor color
where one is set, and Distinct also gives every other part an automatic color. A shown override
replaces vertex colors, which would otherwise hide it. Distinct colors come from the part's
index in the scene into a fixed OKLCh palette, five lightness tones by 72 hues, ordered so each
color is the one farthest from all before it. Any first n parts stay far apart, adding parts
never recolors earlier ones, and moving a part never recolors it. The mode is a view
preference in local storage, Editor by default, and picking a color in Material switches to
Editor. Editor colors are scene data: undoable, saved, recovered, copied with their parts, and
merged in the live view as their own field. A merged part has none. The interference view keeps
its grey parts.

`SceneDocument.lighting` is absent until the user changes the lighting, and the viewport draws
`scene.lighting ?? defaultLighting`. The default is the Studio preset, or lighting the user
saved in local storage. Studio reproduces the editor's original fixed lights value for value,
so a scene that never touched its lighting renders as before. `src/core/lighting.ts` holds the
presets, the limits, and `sanitizeLighting`, which every store change, scene file, recovery,
live-view message, and saved default passes through. Valid lighting comes back unchanged, so it
can run any number of times. Brightness is the renderer's tone-mapping exposure.

`src/components/SceneLighting.tsx` draws the lights. A directional light's position is an
offset from the center of the visible parts' bounding sphere, and only its direction counts.
The light sits three radii out, aims at the center, and fits its shadow camera to the sphere,
so shadows hold at any scene scale. Point lights are world positions with no decay, fading out by
their range. Lights that follow the camera are placed in its frame on every rendered frame and
cast no shadows. The ground contact shadow shows only with Shadows on. It is drei's
ContactShadows adapted to blur where it sits rather than at the origin and to free its render
targets when replaced, so it follows the parts anywhere. Its size steps by powers of two from the
sample's, so ordinary edits never resize it.

The lighting panel is non-modal, docked at the viewport's top left, clear of the view cube and
beside the Interference panel, and becomes a bottom sheet on narrow windows. Every slider,
picker, and handle drag is one undo step: its first change checkpoints and the rest extend it.
While the panel is open, world lights get handles of constant pixel size on an overlay layer
that ground shadows leave out. Directional handles sit on a sphere at 1.2 × the scene's radius,
so they stay in view; only their direction counts. Handle hits take precedence over parts, but
not over overlays such as the view cube, and never change the part selection. With the Select
tool, the active light gets the same translate gizmo as parts, with Shift precision and
snapping; other tools keep their own gizmos and picks, so the two never overlap. The scene's
center and radius are frozen for a drag so a handle never chases itself, and a drag that would
put a directional light on the center is skipped. Turning Follow camera on or off converts the
light's position between the world and camera frames, so it stays where it is.

In the live view, lighting merges in five groups: brightness, ambient, the sky fill with its
colors, shadows, and the whole light list. Agents cannot set editor colors or lighting, and
changes to either are left out of what an agent is told.

## Headset

A headset session runs in the viewport's own canvas and scene. The page's interface is not
shown in a headset and no pointer events reach the canvas, so `src/xr/runtime.ts` reads the
headset's poses each frame and acts on the editor store itself.

The room, in meters, is a group in the scene, in millimeters. `src/core/xr.ts` holds its
position, rotation, and scale as a rig, and the magnification is 1000 divided by that scale.
The viewport's camera moves into the group for the session and goes back exactly as it was, so
lights and anything else that follow the camera follow the viewer's head. Hands, the panel, and
the scale readout are placed in the room, which keeps them their real size at any
magnification. A new view sets the whole model 0.4 m across, 0.55 m ahead of the eyes and
0.25 m below them, upright and seen from its front. A scene that arrives later, or replaces
the one in view, is set the same way.

One hand holding the world moves the rig so that the point it holds stays in it. Two hands
also resize and turn the world about the point between them, and only about the vertical while
Keep level is on. The hands start again from where they are each time one joins or leaves.

A press acts on the first of: a part the hand touches or has reached into, the panel, and a
part the ray meets. Touch reaches 20 mm in the room. The panel is drawn over everything and
takes a ray before any part does, so it stays in reach when a magnified part surrounds it. A
held part is asked to turn with the hand about the point it was taken by, and to travel as far
as the hand has. That request goes through `transformMany` as a gizmo drag does, so joints,
plane constraints, and No clip all apply. Clearing other parts gets 5 ms of a headset frame,
where a mouse drag gets 12, and a part held back keeps closing on a hand that has stopped. A
hold is one undo step, and letting go finishes the clearing at full detail. The drawn parts
move in the same frame, a frame ahead of React.

What needs the mouse, the page, or a second camera is left out of a session: gizmos, the view
cube, point markers, and the ground shadow. Other shadows stop above 300,000 triangles, and
the edge of view gives up detail above 500,000.

`npm run headset` starts `mcp/headset.ts`: the live view's server without an agent, and a
second, encrypted listener for the network. A device there is served one page, which asks for
a six-digit code and trades the right one for the scene's address. Five wrong codes replace
the code. Only tabs on the computer are told the code, and the loopback listener answers as it
always has. The certificate is made on the computer and kept in the user's home folder.

## Camera navigation

The viewport's Camera panel provides explicit Orbit (O) and Pan (H) modes, a
five-button direction pad, and a persistent Orbit selection preference. Camera
modes are separate from assembly tools so entering and leaving navigation does
not discard surface picks. Editing shortcuts leave camera mode; Escape first
returns to the prior tool with picks intact.

When the preference is on, an actual orbit gesture or orbit direction button
uses the current visible selection bounds, including exploded positions and
legacy scan origins. Pan remains free. The period key sets that pivot once
without changing camera distance, direction, or orthographic zoom; F separately
frames the selection. Missing or hidden selections keep the current pivot.
Navigation never changes part transforms or document history.

Middle-drag and held Space + left-drag orbit while point picking or painting;
right-drag pans and the wheel zooms. Left paint gestures reserve the surface
brush. Temporary orbit keeps the active workflow and returns on Space release,
window blur, or pointer cancellation. Right-pan gestures dismiss an early native
context-menu event and preserve the prior selection.

The wheel and zoom buttons glide toward each step, with time-constant smoothing that
lands within a few hundred milliseconds. Any gesture that settles the camera lands an
unfinished glide first. Ctrl + wheel without a held Control key is a trackpad pinch and
follows the gesture directly. Distance limits stop a glide instead of letting it push.

## Preferences

A non-modal side panel over the inspector, so the viewport stays usable while settings
change. Preferences live in local storage, are validated and clamped on load, and sync
across tabs. Keybinding overrides store only differences from the defaults, so later
default changes still reach users who customized other keys.

Point markers are drawn in a DOM layer over the canvas, positioned each rendered frame
from the canvas camera, so their size is in screen pixels. Callout labels keep the
point's screen x, with a vertical leader. They sit a clearance above the projected box
of the visible model, or at a fixed leader length, and stack outward on overlap. Labels near
the top edge hang below their point instead.

The complete interaction and solver contract is in
[cad-constraints-spec.md](cad-constraints-spec.md).
