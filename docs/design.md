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
provide spatial context. Smaller screens use collapsible sidebars.

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
